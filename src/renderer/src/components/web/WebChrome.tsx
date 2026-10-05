import { FolderPickerHost } from "./FolderPickerHost";
import { WebStatusBar } from "./WebStatusBar";

export function WebChrome() {
  return (
    <>
      <FolderPickerHost />
      <WebStatusBar />
    </>
  );
}
