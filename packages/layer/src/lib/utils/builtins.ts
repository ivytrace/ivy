/** Whether a builtin module has been loaded in this thread (without loading it). */
export function isLoaded(name: string): boolean {
  const list = (process as any).moduleLoadList;
  return Array.isArray(list) ? list.includes(`NativeModule ${name}`) : true;
}
