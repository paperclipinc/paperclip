import { Router } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import type { StorageProvider } from "../storage/types.js";
import { assertBoard } from "./authz.js";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES },
});

function runUpload(upload: ReturnType<typeof multer>, req: any, res: any): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
  });
}

export function userRoutes(db: Db, storageProvider: StorageProvider | null) {
  const router = Router();

  // Upload avatar
  router.post("/user/avatar", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

    if (!storageProvider) {
      res.status(501).json({ error: "Storage not configured" });
      return;
    }

    try {
      await runUpload(avatarUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(422).json({ error: "Image exceeds 2 MB" });
        return;
      }
      throw err;
    }

    const file = (req as any).file as { mimetype: string; buffer: Buffer; originalname: string } | undefined;
    if (!file) { res.status(400).json({ error: "Missing file field 'file'" }); return; }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}. Use PNG, JPEG, or WebP.` });
      return;
    }

    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    const objectKey = `__users__/${userId}/avatar${ext}`;

    await storageProvider.putObject({
      objectKey,
      body: file.buffer,
      contentType,
      contentLength: file.buffer.length,
    });

    const avatarUrl = `/api/user/avatar/${userId}`;
    await db.update(authUsers).set({ image: avatarUrl, updatedAt: new Date() }).where(eq(authUsers.id, userId));

    res.json({ url: avatarUrl });
  });

  // Serve avatar
  router.get("/user/avatar/:userId", async (req, res, next) => {
    const userId = req.params.userId as string;
    if (!storageProvider) { res.status(404).end(); return; }

    // Try common extensions
    for (const ext of [".jpg", ".png", ".webp"]) {
      const objectKey = `__users__/${userId}/avatar${ext}`;
      try {
        const head = await storageProvider.headObject({ objectKey });
        if (head.exists) {
          const obj = await storageProvider.getObject({ objectKey });
          res.setHeader("Content-Type", obj.contentType || "image/jpeg");
          if (obj.contentLength) res.setHeader("Content-Length", String(obj.contentLength));
          res.setHeader("Cache-Control", "private, max-age=300");
          res.setHeader("X-Content-Type-Options", "nosniff");
          obj.stream.on("error", (err) => next(err));
          obj.stream.pipe(res);
          return;
        }
      } catch {
        // try next extension
      }
    }
    res.status(404).json({ error: "Avatar not found" });
  });

  // Delete avatar
  router.delete("/user/avatar", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

    if (storageProvider) {
      for (const ext of [".jpg", ".png", ".webp"]) {
        try { await storageProvider.deleteObject({ objectKey: `__users__/${userId}/avatar${ext}` }); } catch { /* ignore */ }
      }
    }
    await db.update(authUsers).set({ image: null, updatedAt: new Date() }).where(eq(authUsers.id, userId));
    res.json({ ok: true });
  });

  return router;
}
