const { nativeImage } = require('electron');
const { join } = require('path');

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const MAX_WIDTH = 1024;
const QUALITY = 80;

function isImage(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

async function serveOptimizedImage(filePath, vault, res) {
  try {
    // Read raw image buffer
    const buffer = await vault.adapter.readBinary(filePath);
    
    // Create native image from buffer
    const image = nativeImage.createFromBuffer(Buffer.from(buffer));
    const size = image.getSize();
    
    // Check if resizing is needed
    if (size.width <= MAX_WIDTH) {
      // Already small enough, serve original
      res.setHeader('Content-Type', `image/${filePath.split('.').pop()}`);
      return res.send(Buffer.from(buffer));
    }
    
    // Calculate new dimensions (maintain aspect ratio)
    const ratio = MAX_WIDTH / size.width;
    const newHeight = Math.round(size.height * ratio);
    
    // Resize image
    const resized = image.resize({
      width: MAX_WIDTH,
      height: newHeight,
      quality: 'good'
    });
    
    // Convert to JPEG for better compression
    const optimized = resized.toJPEG(QUALITY);
    
    console.log(`[Image] Optimized ${filePath}: ${size.width}x${size.height} → ${MAX_WIDTH}x${newHeight} (${buffer.byteLength} → ${optimized.length} bytes)`);
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(optimized);
  } catch (error) {
    console.error('Image optimization error:', error);
    res.status(500).json({ error: 'Failed to optimize image' });
  }
}

module.exports = {
  isImage,
  serveOptimizedImage,
  IMAGE_EXTENSIONS,
  MAX_WIDTH
};
