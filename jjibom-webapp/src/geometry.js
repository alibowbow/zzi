// geometry.js — object-fit aware coordinate transforms.
// The <video> is shown with object-fit and may be letterboxed (contain) or
// cropped (cover). Touch coordinates are in CSS/display space; the analysis
// canvas is in media space. These pure helpers convert between the two so a
// tap always lands on the right pixel regardless of fit / rotation / resize.

import { clamp } from './stats.js';

// Rectangle (in container/display space) that the *whole* media occupies.
// For `cover` the rect can extend outside the container (negative x/y) because
// part of the media is cropped.
export function mediaDisplayRect(containerW, containerH, mediaW, mediaH, fit = 'contain') {
  const safeMediaW = mediaW || 16;
  const safeMediaH = mediaH || 9;
  const scaleContain = Math.min(containerW / safeMediaW, containerH / safeMediaH);
  const scaleCover = Math.max(containerW / safeMediaW, containerH / safeMediaH);
  const scale = fit === 'cover' ? scaleCover : scaleContain;
  const width = safeMediaW * scale;
  const height = safeMediaH * scale;
  return {
    x: (containerW - width) / 2,
    y: (containerH - height) / 2,
    width,
    height,
    scale
  };
}

// Display/CSS point -> media-pixel coordinates.
// `inside` is false when the tap is in the letterbox area (contain) or outside
// the visible region.
export function displayToMedia(pointX, pointY, rect, mediaW, mediaH) {
  const mx = (pointX - rect.x) / rect.scale;
  const my = (pointY - rect.y) / rect.scale;
  const inside = mx >= 0 && mx <= mediaW && my >= 0 && my <= mediaH
    && pointX >= rect.x && pointX <= rect.x + rect.width
    && pointY >= rect.y && pointY <= rect.y + rect.height;
  return {
    x: clamp(mx, 0, mediaW),
    y: clamp(my, 0, mediaH),
    inside
  };
}

// Media-pixel point -> display/CSS coordinates (for drawing the overlay).
export function mediaToDisplay(mediaX, mediaY, rect) {
  return {
    x: rect.x + mediaX * rect.scale,
    y: rect.y + mediaY * rect.scale
  };
}
