/**
 * frame~ capability check.
 *
 * Earlier iterations of this module shared a single `getDisplayMedia` stream
 * across every frame~ instance and handed out cloned tracks. Chromium's
 * Region Capture implementation rejects `track.cropTo(target)` on a track
 * whose source has clones (error: "Can't change target while clones
 * exist."), so the sharing strategy can't apply per-frame crops.
 *
 * Instead, FrameNode now opens its own `getDisplayMedia` per instance —
 * one share-prompt per frame~. preferCurrentTab biases the picker toward
 * patchNet itself so the prompt is one click. This module is kept as a
 * thin support-detection helper so the panel can disable the capture
 * button up-front in non-Chromium browsers.
 */
export const FrameCapture = {
  isSupported(): boolean {
    const w = window as unknown as {
      CropTarget?: { fromElement(el: Element): Promise<unknown> };
    };
    return (
      typeof navigator?.mediaDevices?.getDisplayMedia === "function" &&
      typeof w.CropTarget?.fromElement === "function"
    );
  },
};
