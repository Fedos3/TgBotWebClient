import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const distDir = path.resolve(rootDir, process.argv[2] || 'dist');

copyIntoDist('public');
copyIntoDist('src/lib/rlottie/rlottie-wasm.wasm');
copyIntoDist('node_modules/opus-recorder/dist/decoderWorker.min.wasm');
copyIntoDist('node_modules/emoji-data-ios/img-apple-64');
copyIntoDist('node_modules/emoji-data-ios/img-apple-160');

function copyIntoDist(relativePath) {
  const sourcePath = path.resolve(rootDir, relativePath);
  const sourceStat = fs.statSync(sourcePath);

  fs.mkdirSync(distDir, { recursive: true });
  if (sourceStat.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath)) {
      fs.cpSync(
        path.join(sourcePath, entry),
        path.join(distDir, entry),
        { recursive: true, force: true },
      );
    }
    return;
  }

  fs.cpSync(sourcePath, path.resolve(distDir, path.basename(relativePath)), {
    recursive: true,
    force: true,
  });
}
