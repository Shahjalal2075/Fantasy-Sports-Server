import { Request, Response } from "express";

// The key lives on the server only. Putting it in the app bundle or the
// admin's JS would expose it to anyone who opens dev tools or unpacks the
// APK, and imgbb keys can't be scoped or rate-limited per app.
const IMGBB_API_KEY = process.env.IMGBB_API_KEY ?? "";
const IMGBB_ENDPOINT = "https://api.imgbb.com/1/upload";

// imgbb's own cap is 32 MB, but nothing here needs to be that large and
// base64 inflates payloads by ~33%. 8 MB of decoded image is plenty for
// avatars, team logos and player photos.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/uploads/image  (auth required)
 * body: { imageBase64: string, fileName?: string }
 *
 * Proxies an upload to imgbb and hands back the hosted URL, which callers
 * then store in whichever field they're editing (avatarUrl, logoUrl,
 * imageUrl). Clients never talk to imgbb directly.
 */
export async function uploadImage(req: Request, res: Response) {
  if (!IMGBB_API_KEY) {
    return res.status(500).json({
      error: "Image uploads aren't configured — IMGBB_API_KEY is missing on the server",
    });
  }

  const { imageBase64, fileName } = req.body ?? {};

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 is required" });
  }

  // Accept both a bare base64 string and a full data URL, since the two
  // clients produce different shapes (RN's picker vs the browser's
  // FileReader).
  const payload = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

  // 4 base64 chars encode 3 bytes; close enough to check the limit
  // without decoding the whole thing into memory first.
  const approximateBytes = Math.floor((payload.length * 3) / 4);
  if (approximateBytes > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error: `Image is too large (${Math.round(approximateBytes / 1024 / 1024)} MB). Please use one under 8 MB.`,
    });
  }

  const form = new URLSearchParams();
  form.append("key", IMGBB_API_KEY);
  form.append("image", payload);
  if (fileName && typeof fileName === "string") {
    form.append("name", fileName.replace(/\.[^.]+$/, "").slice(0, 60));
  }

  try {
    const response = await fetch(IMGBB_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const result: any = await response.json();

    if (!response.ok || !result?.success) {
      // imgbb reports its own failures inside the body, so a 200 from
      // fetch doesn't mean the upload worked.
      return res.status(502).json({
        error: result?.error?.message ?? "Image upload failed. Please try again.",
      });
    }

    return res.status(200).json({
      url: result.data.url,
      // Handy for list views — imgbb generates these for us.
      thumbUrl: result.data.thumb?.url ?? result.data.url,
      deleteUrl: result.data.delete_url ?? null,
    });
  } catch (err) {
    return res.status(502).json({ error: "Couldn't reach the image host. Please try again." });
  }
}
