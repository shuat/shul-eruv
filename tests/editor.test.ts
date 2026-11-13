import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { followRoad, moveJoinedPoint, moveLine, nearestRoadPoint, replaceLine } from "../src/editorGeometry.ts";
import { parseConfig } from "../src/configImport.ts";
import type { BoundarySegment, LatLngTuple } from "../src/mapData.ts";

const source = readFileSync(new URL("../src/eruvConfig.json", import.meta.url), "utf8");
const road = { id: "test", name: "Bent Road", points: [[40,-74],[40.001,-74],[40.001,-73.999]] as LatLngTuple[] };
const segment = (id: string, points: LatLngTuple[]): BoundarySegment => ({id, points, label:id, kind:"fullStreet",note:""});

test("moving a whole line moves its shared junctions without double-moving vertices", () => {
  const original = [segment("a", [[40,-74],[41,-74],[42,-74]]), segment("b", [[41,-74],[43,-74]])];
  const result = moveLine(original, "a", [[41,-74],[42,-74],[43,-74]]);
  assert.deepEqual(result[0].points, [[41,-74],[42,-74],[43,-74]]);
  assert.deepEqual(result[1].points, [[42,-74],[43,-74]]);
  assert.deepEqual(original[0].points, [[40,-74],[41,-74],[42,-74]]);
});

test("nearest point projects onto a road, not just a road vertex", () => {
  const result = nearestRoadPoint([40.0005,-74.0001],[road],30);
  assert.ok(result);
  assert.ok(Math.abs(result.point[0] - 40.0005) < 0.000001);
  assert.ok(Math.abs(result.point[1] + 74) < 0.000001);
  assert.equal(nearestRoadPoint([41,-75],[road],30),null);
});

test("follow road retains bends and input direction", () => {
  const forward = followRoad([[40.0002,-74.00001],[40.00101,-73.9992]],road);
  assert.ok(forward.some(p=>Math.abs(p[0]-40.001)<1e-6 && Math.abs(p[1]+74)<1e-6));
  const backward = followRoad([[40.00101,-73.9992],[40.0002,-74.00001]],road);
  assert.deepEqual(backward,forward.slice().reverse());
  assert.throws(()=>followRoad([[41,-75],[41.001,-75]],road),/80 m/);
  assert.throws(()=>followRoad([[40,-74],[40,-74]],road),/same place/);
});

test("moving a junction updates matching vertices without touching other points", () => {
  const a = segment("a",[[40,-74],[40.001,-74]]);
  const b = segment("b",[[40.001,-74],[40.002,-74]]);
  const next: LatLngTuple=[40.0012,-73.9999];
  const result=moveJoinedPoint([a,b],"a",1,next);
  assert.deepEqual(result[0].points[1],next);
  assert.deepEqual(result[1].points[0],next);
  assert.deepEqual(result[1].points[1],b.points[1]);
  assert.deepEqual(a.points[1],[40.001,-74]);
});

test("replacing a line preserves connected endpoints", () => {
  const a=segment("a",[[40,-74],[40.001,-74]]);
  const b=segment("b",[[40.001,-74],[40.002,-74]]);
  const points: LatLngTuple[]=[[40,-74.0001],[40.0005,-74],[40.0011,-74]];
  const result=replaceLine([a,b],"a",points);
  assert.deepEqual(result[1].points[0],points.at(-1));
  assert.deepEqual(result[0].points,points);
});

test("configuration round-trip preserves labels, styling, notes and extra metadata", () => {
  const c=JSON.parse(source);
  c.futureMetadata={revision:3};
  c.mapLabels.push({id:"new-box",label:"woods\nקרפף <test>",position:[40.12,-74.25],variant:"callout",widthPx:160,rotationDeg:15,color:"#aa4841",fontSizePt:8,fontWeight:600});
  assert.deepEqual(parseConfig(JSON.stringify(c)),c);
});

test("invalid imports fail before application state is changed", () => {
  assert.throws(()=>parseConfig("not json"),/valid JSON/);
  assert.throws(()=>parseConfig("{}"),/Invalid configuration/);
  const c=JSON.parse(source);
  c.boundarySegments[0].points[0]=[NaN,0];
  assert.throws(()=>parseConfig(JSON.stringify(c)),/Invalid configuration/);
  const duplicate=JSON.parse(source);
  duplicate.mapLabels.push(duplicate.mapLabels[0]);
  assert.throws(()=>parseConfig(JSON.stringify(duplicate)),/unique ID/);
  const hostile=JSON.parse(source);
  hostile.mapLabels[0].color='red; background:url(test)';
  assert.throws(()=>parseConfig(JSON.stringify(hostile)),/Invalid configuration/);
});

test("bundled road data covers the requested neighborhood", () => {
  const data=JSON.parse(readFileSync(new URL("../src/roads.json",import.meta.url),"utf8"));
  for(const name of ["Drew Court","Brookwood Parkway","Arizona Avenue","Citadel Drive"]) assert.ok(data.roads.some(r=>r.name===name));
  for(const r of data.roads) assert.ok(r.points.length>=2 && r.points.every(p=>p.length===2&&p.every(Number.isFinite)));
});
import { lockMapInteractions } from "../src/mapDragLock.ts";

test("ending a drag cannot release the editor's map lock", () => {
  const pan = {
    active: true,
    enabled() { return this.active; },
    disable() { this.active = false; },
    enable() { this.active = true; },
  };
  const endEditorLock = lockMapInteractions([pan]);
  const endDragLock = lockMapInteractions([pan]);
  endDragLock();
  assert.equal(pan.active, false);
  endEditorLock();
  assert.equal(pan.active, true);

  const first = lockMapInteractions([pan]);
  const second = lockMapInteractions([pan]);
  first();
  assert.equal(pan.active, false);
  second();
  assert.equal(pan.active, true);
});

test("drag lock restores only previously enabled map interactions, once", () => {
  const handler = (initial: boolean) => ({
    active: initial, restores: 0,
    enabled() { return this.active; },
    disable() { this.active = false; },
    enable() { this.active = true; this.restores++; },
  });
  const pan = handler(true);
  const zoom = handler(false);
  const release = lockMapInteractions([pan, zoom]);
  assert.equal(pan.active, false);
  assert.equal(zoom.active, false);
  release();
  release();
  assert.equal(pan.active, true);
  assert.equal(pan.restores, 1);
  assert.equal(zoom.active, false);
  assert.equal(zoom.restores, 0);
});
