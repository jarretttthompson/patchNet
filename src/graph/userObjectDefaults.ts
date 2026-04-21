const STORAGE_KEY = "patchnet-object-size-defaults";

type SizeMap = Record<string, { width: number; height: number }>;

let cache: SizeMap | null = null;

function load(): SizeMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === "object" ? parsed as SizeMap : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // quota exceeded / private mode — silently ignore
  }
}

export function getUserDefaultSize(type: string): { width: number; height: number } | undefined {
  return load()[type];
}

export function setUserDefaultSize(type: string, width: number, height: number): void {
  const map = load();
  map[type] = { width: Math.round(width), height: Math.round(height) };
  save();
}

export function clearUserDefaultSize(type: string): void {
  const map = load();
  if (!(type in map)) return;
  delete map[type];
  save();
}
