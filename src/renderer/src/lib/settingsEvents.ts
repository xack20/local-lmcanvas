// Settings are read per component; a save announces itself so they can re-read.
const SETTINGS_CHANGED_EVENT = "lmc:settings-changed";

export function notifySettingsChanged(): void {
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

export function onSettingsChanged(listener: () => void): () => void {
  window.addEventListener(SETTINGS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
}
