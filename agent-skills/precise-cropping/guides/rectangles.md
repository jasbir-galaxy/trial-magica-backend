# Crop rectangles

For a source W by H pixels and a centered target w by h pixels, use x = floor((W - w) / 2) and y = floor((H - h) / 2). Width and height must be positive and the rectangle must fit within the source. A 640 by 480 image cropped centrally to 320 by 240 uses x=160, y=120, width=320, height=240.

A centered middle-half crop in percentages uses x_percent=25, y_percent=25, width_percent=50, height_percent=50. All four values are required; x + width and y + height must each be at most 100. Do not send both the pixel and percentage forms. For exact requested dimensions use integer pixels.
