import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
	GEMINI_API_KEY: string;
};

function createServer(env: Env) {
	const server = new McpServer({
		name: "Gemini Images for Claude",
		version: "1.0.0",
	});

	server.registerTool(
		"generate_image",
		{
			description:
				"Generate an AI image with Google Gemini. Use this tool when the user asks to create, generate, illustrate, visualize, render, or design an image.",
			inputSchema: {
				prompt: z
					.string()
					.min(1)
					.describe(
						"Detailed description of the image to generate. Write a precise visual prompt including subject, composition, lighting, style, camera angle and relevant constraints.",
					),
			},
		},
		async ({ prompt }) => {
			const response = await fetch(
				"https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": env.GEMINI_API_KEY,
					},
					body: JSON.stringify({
						contents: [
							{
								parts: [{ text: prompt }],
							},
						],
						generationConfig: {
							responseModalities: ["IMAGE"],
						},
					}),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();

				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Gemini API error (${response.status}): ${errorText}`,
						},
					],
				};
			}

			const data: any = await response.json();

			const parts = data?.candidates?.[0]?.content?.parts ?? [];

			const imagePart = parts.find(
				(part: any) => part.inlineData?.data,
			);

			if (!imagePart?.inlineData?.data) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Gemini responded successfully but did not return an image.",
						},
					],
				};
			}

			const mimeType =
				imagePart.inlineData.mimeType ?? "image/png";

			return {
				content: [
					{
						type: "text",
						text: "Image generated successfully with Gemini 3.1 Flash Image.",
					},
					{
						type: "image",
						data: imagePart.inlineData.data,
						mimeType,
					},
				],
			};
		},
	);

	return server;
}

export default {
	fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	) {
		return createMcpHandler(
			() => createServer(env),
		)(request, env, ctx);
	},
};
