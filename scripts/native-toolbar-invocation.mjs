export const invocationHistogram = "Extensions.Toolbar.InvocationSource";

export async function readToolbarInvocation(session) {
  const { histograms } = await session.send("Browser.getHistograms", { query: invocationHistogram, delta: false });
  const histogram = histograms.find(item => item.name === invocationHistogram);
  if (!histogram) return { total: 0, toolbar: 0 };
  return { total: histogram.count, toolbar: histogram.buckets.find(item => item.low === 1 && item.high === 2)?.count ?? 0 };
}

// Chromium's kToolbarButton sample is 1. Clicking a menu entry and calling the
// extension API are different invocation sources.
export function hasSingleToolbarInvocation(before, after) {
  const valid = sample => sample && Number.isSafeInteger(sample.total) && sample.total >= 0 &&
    Number.isSafeInteger(sample.toolbar) && sample.toolbar >= 0 && sample.toolbar <= sample.total;
  return Boolean(valid(before) && valid(after) && after.total - before.total === 1 && after.toolbar - before.toolbar === 1);
}
