import { Ajv, type ValidateFunction } from "ajv";
import type { ProbeTemplate } from "./templates.js";

const ajv = new Ajv({ strict: false });
// Templates hand us a freshly-parsed schema object every probe, so `ajv.compile` would both
// recompile the validator each time and leak it into Ajv's internal registry forever. Cache
// compiled validators by serialized schema; distinct schemas are bounded by the curated set.
const validatorCache = new Map<string, ValidateFunction>();

export function evalSchema(responseJson: unknown, schema: object): boolean {
  try {
    const key = JSON.stringify(schema);
    let validate = validatorCache.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      validatorCache.set(key, validate);
    }
    return validate(responseJson) === true;
  } catch {
    return false;
  }
}

export function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export async function evalGroundTruth(
  responseJson: unknown,
  gt: NonNullable<ProbeTemplate["groundTruth"]>,
  fetchFn: typeof fetch = fetch
): Promise<number | null> {
  let refValue: number;
  try {
    const res = await fetchFn(
      `https://api.coingecko.com/api/v3/simple/price?ids=${gt.refId}&vs_currencies=${gt.refField}`,
      { signal: AbortSignal.timeout(10_000) } // a hung reference must not stall the whole sweep
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    refValue = Number(data?.[gt.refId]?.[gt.refField]);
    if (!Number.isFinite(refValue) || refValue === 0) return null;
  } catch {
    return null; // reference unavailable — not the service's fault
  }
  const actual = Number(getPath(responseJson, gt.path));
  if (!Number.isFinite(actual)) return 100; // service returned garbage — worst case
  return Math.abs((actual - refValue) / refValue) * 100;
}
