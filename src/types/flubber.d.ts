// Ambient types for `flubber` (no upstream @types). We only use the path-string interpolators.
// ADR-003 #1: flubber is the path-morphing plug for the shape socket.
declare module 'flubber' {
  export interface InterpolateOptions {
    /** Resample segments longer than this so endpoints with differing point counts morph cleanly. */
    maxSegmentLength?: number;
    /** Whether the input strings are single paths (default true). */
    single?: boolean;
    /** Keep the path string format (vs returning a ring array). */
    string?: boolean;
  }
  /** Returns an interpolator t∈[0,1] → SVG path `d` string, resampling differing point counts. */
  export function interpolate(
    fromShape: string,
    toShape: string,
    options?: InterpolateOptions,
  ): (t: number) => string;
  export function interpolateAll(
    fromShapes: string[],
    toShapes: string[],
    options?: InterpolateOptions,
  ): Array<(t: number) => string>;
  export function toPathString(ring: ReadonlyArray<[number, number]>): string;
  export function splitPathString(pathString: string): string[];
  // flubber's UMD build only survives interop via the default export (the whole module object).
  const flubber: {
    interpolate: typeof interpolate;
    interpolateAll: typeof interpolateAll;
    toPathString: typeof toPathString;
    splitPathString: typeof splitPathString;
  };
  export default flubber;
}
