declare module "jpeg-js" {
  interface JpegImage {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export function decode(jpegData: Uint8Array, options?: {
    useTArray?: boolean;
    formatAsRGBA?: boolean;
    maxResolutionInMP?: number;
  }): JpegImage;

  export function encode(image: JpegImage, quality?: number): JpegImage;
}
