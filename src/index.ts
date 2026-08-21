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
		version: "2.1.0",
	});

	server.registerTool(
		"generate_image",
		{
			description:
				"Generate an AI image with Google Gemini, save it as a real file in Cloudflare R2, and return both the image and a reusable file URL.",
			inputSchema: {
				prompt: z
					.string()
					.min(1)
					.describe("Detailed visual prompt describing the image to generate."),

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
					.default("1:1"),

				image_size: z
					.enum(["512", "1K", "2K", "4K"])
					.default("1K"),
			},
		},

		async ({ prompt, filename, aspect_ratio, image_size }) => {
			const response = await fetch(
				"https://generativelanguage.googleapis.com/v1beta/interactions",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": env.GEMINI_API_KEY,
					},
					body: JSON.stringify({
						model: "gemini-3.1-flash-image",

						input: [
							{
								type: "text",
								text: prompt,
							},
						],

						response_format: {
							type: "image",
							aspect_ratio: aspect_ratio,
							image_size: image_size,
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

			const allContent =
				data?.steps?.flatMap(
					(step: any) => step?.content ?? [],
				) ?? [];

			const imageItem = allContent.find(
				(item: any) =>
					item?.type === "image" &&
					typeof item?.data === "string",
			);

			if (!imageItem?.data) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text:
								"Gemini completed the request but no image data was found in the response.",
						},
					],
				};
			}

			const base64 = imageItem.data;

			const mimeType =
				imageItem.mime_type ?? "image/png";

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
							`This URL points to the actual generated image file and may be used by another connector.`,
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
							"Generated Gemini image stored in Cloudflare R2.",
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

		const handler = createMcpHandler(
			() => createServer(env, url.origin),
		);

		return handler(request, env, ctx);
	},
};
