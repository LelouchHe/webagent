export function scrollMetrics(el: HTMLElement): Record<string, number> {
  return {
    scrollTop: Math.round(el.scrollTop),
    clientHeight: Math.round(el.clientHeight),
    scrollHeight: Math.round(el.scrollHeight),
  };
}
