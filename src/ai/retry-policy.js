'use strict';

const RETRY_WINDOW_MS = 60_000;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const WEEKDAYS={Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday',Sat:'Saturday',Sun:'Sunday'};
const MONTHS={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};

function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const header = value.trim();
  if (/^\d+$/.test(header)) {
    const normalized=header.replace(/^0+(?=\d)/,'');
    const seconds = Number(normalized);
    return seconds > RETRY_WINDOW_MS / 1000 ? RETRY_WINDOW_MS + 1 : seconds * 1000;
  }
  let weekday,day,month,hour,minute,second,year,parseValue=header;
  let match=header.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/);
  if(match){[,weekday,day,month,year,hour,minute,second]=match;}
  else {
    match=header.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/);
    if(match){[,weekday,day,month,year,hour,minute,second]=match;weekday=Object.keys(WEEKDAYS).find((key)=>WEEKDAYS[key]===weekday);}
    else {
      match=header.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-3]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
      if(!match)return null;
      [,weekday,month,day,hour,minute,second,year]=match;day=day.trim();
      parseValue=`${month} ${day} ${year} ${hour}:${minute}:${second} GMT`;
    }
  }
  const timestamp = Date.parse(parseValue);
  if (!Number.isFinite(timestamp)) return null;
  const date=new Date(timestamp);
  if(date.toUTCString().slice(0,3)!==weekday || date.getUTCDate()!==Number(day) || date.getUTCMonth()!==MONTHS[month] || date.getUTCHours()!==Number(hour) || date.getUTCMinutes()!==Number(minute) || date.getUTCSeconds()!==Number(second) || (String(year).length===4 && date.getUTCFullYear()!==Number(year)) || (String(year).length===2 && date.getUTCFullYear()%100!==Number(year)))return null;
  return Math.max(0, timestamp - nowMs);
}

function retryDelayMs({ retryAfterMs, attempt, random = Math.random }) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    if (retryAfterMs > RETRY_WINDOW_MS)
      return { delayMs: null, disposition: 'outside_window' };
    return {
      delayMs: Math.max(MIN_RETRY_WAIT_MS, retryAfterMs),
      disposition: 'scheduled',
    };
  }
  const exponent = Math.max(0, Math.min(5, attempt - 1));
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** exponent);
  const jitter = Math.min(MAX_BACKOFF_MS, backoff * (0.5 + random()));
  return {
    delayMs: Math.min(RETRY_WINDOW_MS, Math.max(MIN_RETRY_WAIT_MS, Math.round(jitter))),
    disposition: 'scheduled',
  };
}

module.exports = {
  RETRY_WINDOW_MS,
  parseRetryAfter,
  retryDelayMs,
};
