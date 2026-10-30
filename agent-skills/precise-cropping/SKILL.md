---
name: precise-cropping
description: Plan or perform precise image crops while preserving pixel or percentage units. Load for aspect ratios, centered crops, complete rectangles and image cropping.
---
# Precise cropping

Identify the source image and the user's units. The `crop` object and fields ending in `_px` use pixels; fields ending in `_percent` use percentages. Do not convert 50 percent into 50 pixels. Supply exactly one complete rectangle using the current crop tool schema.

For centered crops or aspect-ratio calculations, read `guides/rectangles.md`. Request missing source dimensions if they are needed for exact pixel geometry. Never invent an image URL or claim that a plan is a generated image.

Use the ordinary crop tool only when execution is requested, and respect its approval and credit checks. In a generation-then-crop task, pass the exact generated result URL into the crop tool. Check returned dimensions and preserve all completed assets if a later step fails.
