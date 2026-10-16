/**
 * Directories skipped by every extension walk (list, glob and grep):
 * dependencies, VCS metadata, build output, caches and shadow worktrees.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
  '.kilo',
  'coverage',
  'out',
  '.output',
  'vendor',
  'target',
  '.idea',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.svelte-kit',
  '.angular',
  '.parcel-cache',
  '.nuxt',
  '.nyc_output',
  'DerivedData',
  '.worktrees',
  '.dev-data',
  'release',
  'temp',
  'tmp',
  '.husky'
])

/**
 * Common non-text extensions skipped by grep search to prevent reading huge
 * binary or encoded assets into memory.
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff', '.svgz',
  // Audio & Video
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.mp4', '.webm', '.avi', '.mov', '.mkv',
  // Archives & Compressed
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz', '.tgz',
  // Executables & Binaries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node',
  // ML / Models & Weights
  '.onnx', '.pt', '.pth', '.safetensors', '.tflite',
  // Fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  // Documents & DBs
  '.pdf', '.sqlite', '.sqlite3', '.db', '.db-wal', '.db-shm',
  // Bytecode & WebAssembly
  '.pyc', '.pyo', '.class', '.wasm'
])

module.exports = {
  IGNORED_DIRS,
  BINARY_EXTENSIONS
}

