import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const validator = require('gltf-validator');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'node_modules/@gltf-transform/cli/bin/cli.js');
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: real_export.mjs source.glb output.glb');
function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 600000, maxBuffer: 8*1024*1024 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || String(r.error));
}
const intermediate = output + '.ktx.glb';
try {
  run(['etc1s', source, intermediate, '--quality', '180', '--jobs', '2']);
  run(['draco', intermediate, output]);
  const bytes = fs.readFileSync(output);
  const report = await validator.validateBytes(new Uint8Array(bytes));
  if (report.issues.numErrors) throw new Error(JSON.stringify(report.issues));
  const length = bytes.readUInt32LE(12); const doc = JSON.parse(bytes.subarray(20,20+length).toString());
  if (!doc.extensionsRequired?.includes('KHR_draco_mesh_compression')) throw new Error('Draco not applied');
  if (!doc.extensionsRequired?.includes('KHR_texture_basisu')) throw new Error('KTX2 not applied (missing real PBR textures)');
  const sourceBytes=fs.readFileSync(source);const sourceDoc=JSON.parse(sourceBytes.subarray(20,20+sourceBytes.readUInt32LE(12)).toString());
  if (JSON.stringify(doc.asset?.extras?.AIGC) !== JSON.stringify(sourceDoc.asset?.extras?.AIGC)) throw new Error('AIGC provenance was changed during compression');
  // The pinned Khronos validator does not decode these extensions. Decode the real
  // compressed geometry independently and verify actual KTX2 headers as well.
  const {NodeIO}=await import('@gltf-transform/core');
  const {ALL_EXTENSIONS}=await import('@gltf-transform/extensions');
  const draco=require('draco3dgltf');
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'draco3d.decoder':await draco.createDecoderModule()});
  const decoded=await io.read(output);let triangles=0;
  for(const m of decoded.getRoot().listMeshes()) for(const p of m.listPrimitives()) {
    const positions=p.getAttribute('POSITION');const indices=p.getIndices();
    if(!positions||!indices)throw new Error('Decoded primitive is missing geometry');
    if([...positions.getArray()].some(v=>!Number.isFinite(v)))throw new Error('Non-finite decoded position');
    if([...indices.getArray()].some(i=>i>=positions.getCount()))throw new Error('Decoded index out of bounds');
    triangles+=indices.getCount()/3;
  }
  for(const texture of decoded.getRoot().listTextures()) {
    if(texture.getMimeType()!=='image/ktx2'||Buffer.from(texture.getImage()).subarray(0,12).toString('hex')!=='ab4b5458203230bb0d0a1a0a') throw new Error('Invalid KTX2 texture');
  }
  console.log(JSON.stringify({bytes:bytes.length,errors:0,warnings:report.issues.numWarnings,decodedTriangles:triangles,extensions:doc.extensionsRequired}));
} finally { if(fs.existsSync(intermediate)) fs.unlinkSync(intermediate); }
