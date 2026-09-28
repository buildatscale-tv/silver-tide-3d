# Make a texture tile seamlessly: blend the image with copies rolled by half a
# tile, weighting each copy to zero along its own seam, then restore contrast
# with a variance-preserving normalization. Usage: seamless.py in out size
import sys
import numpy as np
from PIL import Image

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
img = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32)
H, W, _ = img.shape
y = (np.arange(H)[:, None] + 0.5) / H
x = (np.arange(W)[None, :] + 0.5) / W
ax = np.sin(np.pi * x) ** 2
ay = np.sin(np.pi * y) ** 2
rx = np.roll(img, W // 2, axis=1)
imgs = [img, rx, np.roll(img, H // 2, axis=0), np.roll(rx, H // 2, axis=0)]
ws = [ax * ay, (1 - ax) * ay, ax * (1 - ay), (1 - ax) * (1 - ay)]
mean = img.mean(axis=(0, 1))
num = sum(w[..., None] * (im - mean) for w, im in zip(ws, imgs))
norm = np.sqrt(sum(w ** 2 for w in ws))[..., None]
out = np.clip(mean + num / norm, 0, 255).astype(np.uint8)
Image.fromarray(out).resize((size, size), Image.LANCZOS).save(dst, quality=90)
print("wrote", dst)
