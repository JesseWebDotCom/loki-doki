// Minimal ambient types for osm-pbf-parser (no bundled @types).
// The default export is a factory returning a Transform stream that emits
// arrays of decoded OSM items on 'data'.
declare module 'osm-pbf-parser' {
  import type { Transform } from 'node:stream'
  export default function parseOSM(): Transform
}
