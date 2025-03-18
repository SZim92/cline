/**
 * Implementation of ApiHandler for Google's Gemini models.
 * This handler adapts Gemini's API to the common ApiHandler interface,
 * allowing Gemini models to be used with an Anthropic-compatible system.
 */
import { Anthropic } from "@anthropic-ai/sdk"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { withRetry } from "../retry"
import { ApiHandler } from "../"
import { ApiHandlerOptions, geminiDefaultModelId, GeminiModelId, geminiModels, ModelInfo } from "../../shared/api"
import { convertAnthropicMessageToGemini, unescapeGeminiContent } from "../transform/gemini-format"
import { ApiStream } from "../transform/stream"

/**
 * Handler for interacting with Google's Gemini API.
 * Implements the common ApiHandler interface, providing message generation
 * and model selection functionality compatible with the application's
 * Anthropic-based architecture.
 */
export class GeminiHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: GoogleGenerativeAI

	/**
	 * Creates a new GeminiHandler instance.
	 *
	 * @param options - Configuration options including the Gemini API key
	 * @throws Error if geminiApiKey is not provided in options
	 */
	constructor(options: ApiHandlerOptions) {
		if (!options.geminiApiKey) {
			throw new Error("API key is required for Google Gemini")
		}
		this.options = options
		this.client = new GoogleGenerativeAI(options.geminiApiKey)
	}

	/**
	 * Generates content from Gemini models based on messages in Anthropic format.
	 * Uses stream processing to return results as they become available.
	 * Decorated with @withRetry to automatically retry on transient failures.
	 *
	 * @param systemPrompt - Instructions to guide the model's behavior
	 * @param messages - Array of messages in Anthropic format
	 * @yields Streaming text content and usage information
	 */
	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const model = this.client.getGenerativeModel({
			model: this.getModel().id,
			systemInstruction: systemPrompt,
		})

		try {
			const result = await model.generateContentStream({
				contents: messages.map(convertAnthropicMessageToGemini),
				generationConfig: {
					maxOutputTokens: this.getModel().info.maxTokens,
					temperature: 0, // Consistent with other handlers in the codebase
				},
			})

			let hasError = false
			for await (const chunk of result.stream) {
				try {
					const text = chunk.text()
					if (text) {
						yield {
							type: "text",
							text: unescapeGeminiContent(text),
						}
					}
				} catch (error) {
					hasError = true
					console.error("Error processing stream chunk:", error)
					throw error
				}
			}

			if (hasError) {
				throw new Error("Stream processing encountered errors")
			}

			const response = await result.response
			if (!response) {
				throw new Error("No response received from Gemini API")
			}

			// Check for finish reason
			const finishReason = response.candidates?.[0]?.finishReason
			if (finishReason === "SAFETY") {
				throw new Error("Content generation was blocked for safety reasons")
			} else if (finishReason === "RECITATION") {
				throw new Error("Content generation was blocked due to potential copyright issues")
			} else if (finishReason === "OTHER") {
				throw new Error("Content generation was blocked for other reasons")
			}

			yield {
				type: "usage",
				inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
				outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
			}
		} catch (error) {
			console.error("Error in Gemini message generation:", error)
			throw error
		}
	}

	/**
	 * Determines which Gemini model to use based on configuration or defaults.
	 *
	 * @returns Object containing the model ID and associated model information
	 */
	getModel(): { id: GeminiModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in geminiModels) {
			const id = modelId as GeminiModelId
			return { id, info: geminiModels[id] }
		}
		return {
			id: geminiDefaultModelId,
			info: geminiModels[geminiDefaultModelId],
		}
	}
}
