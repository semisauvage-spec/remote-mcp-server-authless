import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
	GEMINI_API_KEY: string;
	IMAGES: R2Bucket;
};

function mimeExtension(mimeType: string) {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	return "png";
}

function cleanFilename(name: string) {
	return name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
}

function base64ToBytes(base64: string) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}

function createServer(env: Env, origin: string) {
	const server = new McpServer({
		name: "Gemini Images for Claude",
		version: "2.0.0",
	});

	server.registerTool(
		"generate_image",
		{
			description:
				"Generate an AI image with Google Gemini, save it as a real file, and return both the image and a downloadable file URL. Use this tool whenever the user asks to create, generate, illustrate, visualize, render or design an image.",
			inputSchema: {
				prompt: z
					.string()
					.min(1)
					.describe(
						"Detailed visual prompt describing the image to generate.",
					),

				filename: z
					.string()
					.optional()
					.describe(
						"Desired filename without extension, for example lavande-vraie-jardin-xixe.",
					),

				aspect_ratio: z
					.enum([
						"1:1",
						"1:4",
						"4:1",
						"1:8",
						"8:1",
						"2:3",
						"3:2",
						"3:4",
						"4:3",
						"4:5",
						"5:4",
						"9:16",
						"16:9",
						"21:9",
					])
					.default("1:1")
					.describe("Aspect ratio of the generated image."),

				image_size: z
					.enum(["512", "1K", "2K", "4K"])
					.default("1K")
					.describe(
						"Image resolution. 1K gives 1024x1024 for a square image.",
					),
			},
		},

		async ({
			prompt,
			filename,
			aspect_ratio,
			image_size,
		}) => {
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
							responseFormat: {
								image: {
									aspectRatio: aspect_ratio,
									imageSize: image_size,
								},
							},
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

			const parts =
				data?.candidates?.[0]?.content?.parts ?? [];

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

			const base64 = imagePart.inlineData.data;

			const mimeType =
				imagePart.inlineData.mimeType ?? "image/png";

			const extension = mimeExtension(mimeType);

			const basename =
				cleanFilename(filename ?? "") ||
				`gemini-${crypto.randomUUID()}`;

			const key = `${basename}.${extension}`;

			const bytes = base64ToBytes(base64);

			await env.IMAGES.put(key, bytes, {
				httpMetadata: {
					contentType: mimeType,
					contentDisposition: `inline; filename="${key}"`,
					cacheControl:
						"public, max-age=31536000, immutable",
				},
			});

			const fileUrl =
				`${origin}/files/${encodeURIComponent(key)}`;

			return {
				content: [
					{
						type: "text",
						text:
							`Image generated and saved successfully.\n` +
							`Filename: ${key}\n` +
							`File URL: ${fileUrl}\n` +
							`Claude may use this URL as the source file for another connector or service.`,
					},
					{
						type: "image",
						data: base64,
						mimeType,
					},
					{
						type: "resource_link",
						name: key,
						title: key,
						uri: fileUrl,
						description:
							"Generated Gemini image stored as a downloadable file.",
						mimeType,
						size: bytes.byteLength,
					},
				],
			};
		},
	);

	return server;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	) {
		const url = new URL(request.url);

		/*
		 * Serve generated images as real HTTP files.
		 */
		if (
			request.method === "GET" &&
			url.pathname.startsWith("/files/")
		) {
			const key = decodeURIComponent(
				url.pathname.substring("/files/".length),
			);

			const object = await env.IMAGES.get(key);

			if (object === null) {
				return new Response("Image not found", {
					status: 404,
				});
			}

			const headers = new Headers();

			object.writeHttpMetadata(headers);
			headers.set("etag", object.httpEtag);
			headers.set(
				"Access-Control-Allow-Origin",
				"*",
			);

			return new Response(object.body, {
				headers,
			});
		}

		/*
		 * Everything else is handled by the MCP server.
		 */
		const handler = createMcpHandler(
			() => createServer(env, url.origin),
		);

		return handler(request, env, ctx);
	},
};
