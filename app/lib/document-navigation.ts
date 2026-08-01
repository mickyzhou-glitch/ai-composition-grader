type DocumentLocation = Pick<Location, "replace">;

export function replaceDocument(pathname: string, location: DocumentLocation = window.location): void {
  location.replace(pathname);
}
