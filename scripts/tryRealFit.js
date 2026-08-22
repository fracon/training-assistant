'use strict';

const fs = require('node:fs');
const { calculateCRC } = require('fit-file-parser/dist/binary');
const { parseFitFile } = require('../src/fitParser');

const EPOCH_OFFSET = 631065600;

function u16(value) {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function definition(localType, messageNumber, fields) {
  return Buffer.from([
    0x40 | localType,
    0x00,
    0x00,
    ...u16(messageNumber),
    fields.length,
    ...fields.flat(),
  ]);
}

function fitTime(unixMs) {
  return Math.floor(unixMs / 1000) - EPOCH_OFFSET;
}

function buildFit() {
  const start = fitTime(Date.parse('2026-02-03T07:30:00Z'));
  const mid = fitTime(Date.parse('2026-02-03T07:40:00Z'));
  const end = fitTime(Date.parse('2026-02-03T08:10:00Z'));

  const lapDef = definition(0, 19, [
    [254, 2, 0x84],
    [0, 1, 0x00],
    [1, 1, 0x00],
    [2, 4, 0x86],
    [7, 4, 0x86],
    [8, 4, 0x86],
    [9, 4, 0x86],
    [13, 2, 0x84],
    [14, 2, 0x84],
    [15, 1, 0x02],
    [16, 1, 0x02],
    [17, 1, 0x02],
    [18, 1, 0x02],
    [21, 2, 0x84],
    [22, 2, 0x84],
    [11, 2, 0x84],
    [23, 1, 0x00],
  ]);

  function lapData(index, startTime, elapsedMs, distanceCm, maxSpeedMms, calories, intensity) {
    return Buffer.concat([
      Buffer.from([index]),
      u16(index),
      Buffer.from([9, 1]),
      u32(startTime),
      u32(elapsedMs),
      u32(elapsedMs),
      u32(distanceCm),
      u16(Math.round((distanceCm / elapsedMs) * 1000000)),
      u16(maxSpeedMms),
      Buffer.from([150, 162]),
      Buffer.from([88, 92]),
      u16(index === 0 ? 12 : 5),
      u16(index === 0 ? 4 : 9),
      u16(calories),
      Buffer.from([intensity]),
    ]);
  }

  const sessionDef = definition(1, 18, [
    [254, 2, 0x84],
    [253, 4, 0x86],
    [2, 4, 0x86],
    [5, 1, 0x00],
  ]);
  const sessionData = Buffer.concat([
    Buffer.from([1]),
    u16(0),
    u32(end),
    u32(start),
    Buffer.from([1]),
  ]);

  const body = Buffer.concat([
    lapDef,
    lapData(0, start, 600400, 200000, 6667, 60, 0),
    lapDef,
    lapData(1, mid, 1200000, 300000, 5556, 80, 1),
    sessionDef,
    sessionData,
  ]);

  const headerBase = Buffer.concat([
    Buffer.from([14, 0x10, 0x20, 0x00]),
    u32(body.length),
    Buffer.from([0x2e, 0x46, 0x49, 0x54]),
  ]);
  const headerCrc = calculateCRC(headerBase, 0, 12);
  const header = Buffer.concat([headerBase, u16(headerCrc)]);

  const fileCrcStart = header.length + body.length;
  const fileCrc = calculateCRC(Buffer.concat([header, body]), header.length, fileCrcStart);

  return Buffer.concat([header, body, u16(fileCrc)]);
}

async function main() {
  const arg = process.argv[2];
  let buffer;
  if (arg && fs.existsSync(arg)) {
    buffer = fs.readFileSync(arg);
  } else {
    buffer = buildFit();
    if (arg) fs.writeFileSync(arg, buffer);
    console.log('(no input file found - generated a synthetic FIT instead)');
  }
  const summary = await parseFitFile(buffer);
  console.log(JSON.stringify(summary.activity));
  console.table(summary.laps.map((l) => ({
    step: l.stepType,
    lap: l.lap,
    dur: l.durationLabel,
    cum: l.cumulativeLabel,
    km: l.distanceLabel,
    avgPace: l.avgPaceLabel,
    bestPace: l.bestPaceLabel,
    hr: `${l.avgHeartRate}/${l.maxHeartRate}`,
    cad: `${l.avgCadenceSpm}/${l.maxCadenceSpm}`,
    up: l.ascentMeters,
    kcal: l.calories,
  })));
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
