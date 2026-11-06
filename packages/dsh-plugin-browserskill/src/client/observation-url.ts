/** Keep plugin routes under DSH's document base when it is mounted below a path. */
export function observationUrl(path: string): string {
  if (typeof document === "undefined") return `/bsk-observation/${path}`;
  return new URL(`bsk-observation/${path}`, document.baseURI).pathname;
}
