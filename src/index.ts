import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
	GEMINI_API_KEY: string;
	IMAGES: R2Bucket;
	IMAGE_TRANSFORMER: any;
};

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

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 32768;

	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(
			i,
			Math.min(i + chunkSize, bytes.length),
		);

		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

function createServer(env: Env, origin: string) {
	const server = new McpServer({
		name: "Gemini Images for Claude",
		version: "3.0.0",
	});

	server.registerTool(
		"generate_image",
		{
			description:
				"Generate an AI image with Google Gemini, optimize it as WebP for e-commerce, save it to Cloudflare R2, and return a reusable file URL.",

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
					.default("1:1"),

				image_size: z
					.enum(["512", "1K", "2K", "4K"])
					.default("1K"),
			},
		},

		async ({
			prompt,
			filename,
			aspect_ratio,
			image_size,
		}) => {
			/*
			 * 1. Generate the original image with Gemini
			 */
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
							aspect_ratio,
							image_size,
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
							text:
								`Gemini API error (${response.status}): ` +
								errorText,
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
								"Gemini completed the request but no image data was found.",
						},
					],
				};
			}

			/*
			 * 2. Decode Gemini image
			 */
			const originalBytes =
				base64ToBytes(imageItem.data);

			/*
			 * 3. Convert to WebP
			 *
			 * Maximum 1600 x 1600.
			 * scale-down preserves aspect ratio
			 * and never enlarges smaller images.
			 *
			 * WebP quality = 80.
			 */
			const transformed = await env
				.IMAGE_TRANSFORMER
				.input(originalBytes)
				.transform({
					width: 1600,
					height: 1600,
					fit: "scale-down",
				})
				.output({
					format: "image/webp",
					quality: 80,
				});

			const webpResponse = transformed.response();

			if (!webpResponse.ok) {
				const errorText =
					await webpResponse.text();

				return {
					isError: true,
					content: [
						{
							type: "text",
							text:
								`WebP conversion error: ${errorText}`,
						},
					],
				};
			}

			const webpBytes = new Uint8Array(
				await webpResponse.arrayBuffer(),
			);

			/*
			 * 4. Build final SEO-friendly filename
			 */
			const basename =
				cleanFilename(filename ?? "") ||
				`gemini-${crypto.randomUUID()}`;

			const key = `${basename}.webp`;

			/*
			 * 5. Store ONLY the optimized WebP in R2
			 */
			await env.IMAGES.put(
				key,
				webpBytes,
				{
					httpMetadata: {
						contentType: "image/webp",

						contentDisposition:
							`inline; filename="${key}"`,

						cacheControl:
							"public, max-age=31536000, immutable",
					},
				},
			);

			const fileUrl =
				`${origin}/files/${encodeURIComponent(key)}`;

			const webpBase64 =
				bytesToBase64(webpBytes);

			/*
			 * 6. Return the actual optimized WebP to Claude
			 */
			return {
				content: [
					{
						type: "text",

						text:
							`Image generated and optimized successfully.\n` +
							`Format: WebP\n` +
							`Quality: 80\n` +
							`Maximum dimensions: 1600 × 1600 px\n` +
							`Filename: ${key}\n` +
							`File URL: ${fileUrl}`,
					},

					{
						type: "image",
						data: webpBase64,
						mimeType: "image/webp",
					},

					{
						type: "resource_link",
						name: key,
						title: key,
						uri: fileUrl,

						description:
							"Optimized WebP image generated by Gemini and stored in Cloudflare R2.",

						mimeType: "image/webp",
						size: webpBytes.byteLength,
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
		 * Serve generated WebP files
		 */
		if (
			request.method === "GET" &&
			url.pathname.startsWith("/files/")
		) {
			const key = decodeURIComponent(
				url.pathname.substring(
					"/files/".length,
				),
			);

			const object =
				await env.IMAGES.get(key);

			if (object === null) {
				return new Response(
					"Image not found",
					{ status: 404 },
				);
			}

			const headers =
				new Headers();

			object.writeHttpMetadata(headers);

			headers.set(
				"etag",
				object.httpEtag,
			);

			headers.set(
				"Access-Control-Allow-Origin",
				"*",
			);

			return new Response(
				object.body,
				{ headers },
			);
		}

		const handler =
			createMcpHandler(
				() =>
					createServer(
						env,
						url.origin,
					),
			);

		return handler(
			request,
			env,
			ctx,
		);
	},
};
