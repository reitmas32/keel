const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isSemverTag = (tag: string) => SEMVER_TAG.test(tag);

/** Orders `v`-prefixed semver tags descending; a prerelease sorts below its release. */
export function compareSemverDesc(a: string, b: string): number {
  const [, aMaj, aMin, aPat, aPre] = a.match(SEMVER_TAG) ?? [];
  const [, bMaj, bMin, bPat, bPre] = b.match(SEMVER_TAG) ?? [];
  for (const [x, y] of [
    [aMaj, bMaj],
    [aMin, bMin],
    [aPat, bPat],
  ]) {
    const diff = Number(y) - Number(x);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (!aPre) return -1;
  if (!bPre) return 1;
  return bPre.localeCompare(aPre, undefined, { numeric: true });
}
