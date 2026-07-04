import { Ajv } from "ajv";
import type { ProbeTemplate } from "./templates.js";

const ajv = new Ajv({ strict: false });

export function evalSchema(responseJson: unknown, schema: object): boolean {
  try {
    return ajv.compile(schema)(responseJson) === true;
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
      `https://api.coingecko.com/api/v3/simple/price?ids=${gt.refId}&vs_currencies=${gt.refField}`
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
