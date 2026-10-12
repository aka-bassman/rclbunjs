import { describe, expect, test } from "bun:test";
import { from, map, toArray } from "rxjs";
import { MiniSubject, ObservableSubscription } from "../../src/core/observableSubscription.ts";

describe("ObservableSubscription without rxjs", () => {
  test("MiniSubject delivers, unsubscribes and completes", () => {
    const s = new MiniSubject<number>();
    const obs = s.asObservable();
    const a: number[] = [];
    const b: number[] = [];
    let completed = false;
    const ua = obs.subscribe((v) => a.push(v));
    obs.subscribe({ next: (v) => b.push(v), complete: () => (completed = true) });
    s.next(1);
    ua.unsubscribe();
    s.next(2);
    s.complete();
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    expect(completed).toBe(true);
    let late = false;
    obs.subscribe({ complete: () => (late = true) });
    expect(late).toBe(true);
  });

  test("MiniSubject is consumable by rxjs through the interop protocol", async () => {
    const s = new MiniSubject<number>();
    const out = from(s.asObservable() as any).pipe(map((v: any) => v * 10), toArray()).toPromise();
    s.next(1);
    s.next(2);
    s.complete();
    expect(await out).toEqual([10, 20]);
  });

  test("async iteration ends on complete()", async () => {
    const fake = { topic: "/t" } as any;
    const os = new ObservableSubscription<number>(fake);
    const got: number[] = [];
    const done = (async () => {
      for await (const v of os) got.push(v);
    })();
    os._emit(1);
    os._emit(2);
    await Bun.sleep(1);
    os.complete();
    await done;
    expect(got).toEqual([1, 2]);
    expect(os.topic).toBe("/t");
  });
});
