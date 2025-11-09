const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const cheerio = require('cheerio');
const fs = require('fs');
const cookie = require('cookie');

const app = express();
app.use(cors());
const PORT = 3000;

// Util: parseBookingUrl is not needed here; we get country/hotel as params

// --- Parallel race wrapper for Booking.com fetches ---
async function fetchWithParallelRace(url, options = {}, numParallel = 1, maxWaves = 3, delayMs = 750) {
  for (let wave = 1; wave <= maxWaves; wave++) {
    const attempts = [];
    for (let i = 0; i < numParallel; i++) {
      attempts.push(
        fetch(url, options)
          .then(async res => {
            if (res.status === 200) {
              return res;
            }
            const text = await res.text()
            return Promise.reject(new Error(`Non-200: ${res.status}, text: ${text}`))
          })
      );
    }
    try {
      // Возьмёт первый успешно завершившийся промис
      const res = await Promise.any(attempts);
      return res;
    } catch (err) {
      console.warn(`Wave #${wave}: Все параллельные попытки неудачны (${numParallel})`, err);
      if (wave < maxWaves) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`All parallel waves to Booking.com failed for URL: ${url}`);
}

// getReviewsPages теперь принимает дополнительный объект options с возможностью собрать cookies.
async function getReviewsPages(country, hotel, options = {}) {
  let sessionCookie = null;
  const initialReviews = `https://www.booking.com/reviewlist.ru.html?cc1=${country}&dist=1&pagename=${hotel}&offset=0&rows=10`;
  const res = await fetchWithParallelRace(initialReviews, {});
  // Извлечение set-cookie
  const setCookieArr = res.headers.raw()['set-cookie'] || [];
  if (setCookieArr.length) {
    const wanted = ['bkng', 'pcm_consent', 'bkng_sso_auth'];
    const parsedCookies = setCookieArr.flatMap(c => {
      const parsed = cookie.parse(c);
      return Object.entries(parsed);
    });
    sessionCookie = parsedCookies
      .filter(([k, _]) => wanted.includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  const paginationItems = $('a.bui-pagination__link');
  if (paginationItems.length === 0) {
    console.warn('Could not get pages count')
    return { pages: 10, sessionCookie };
  }
  const last = paginationItems.last();
  const pageStr = $(last).find('span[aria-hidden="true"]').text().trim();
  return { pages: Number(pageStr), sessionCookie };
}

// getReviews теперь принимает sessionCookie, передает далее
async function getReviews(country, hotel, pages, sessionCookie) {
  const promises = Array.from({ length: pages }, (_, i) => getReviewsPage(country, hotel, i + 1, sessionCookie));
  const reviews = await Promise.all(promises);
  return reviews.flat().filter(item => item != null);
}

// getReviewsPage принимает sessionCookie
async function getReviewsPage(country, hotel, page, sessionCookie) {
  const initialReviews = `https://www.booking.com/reviewlist.en.html?cc1=${country}&dist=1&pagename=${hotel}&offset=${(page - 1) * 10}&rows=10&lang=en&translated=1&hl=en`;
  try {
    let options = {};

    if (sessionCookie) {
      options = {
        headers: {
          'Cookie': sessionCookie
        }
      }
    }
    const res = await fetchWithParallelRace(initialReviews, options);
    const html = await res.text();
    const $ = cheerio.load(html);
    const reviewBlocks = $('div.c-review');
    return reviewBlocks.map((i, block) => {
      const rows = $(block).find('div.c-review__row');
      const raw = [];
      rows.each((j, item) => {
        const t = $(item).text().replace(/\n/g, '').split('·').map(s => s.trim());
        raw.push(t);
      });
      if (raw.length == 1 && raw[0].length == 1) return null;
      let good, bad;
      raw.forEach(item => {
        if (item.length !== 2) return;
        if (!good) good = item[1];
        else bad = item[1];
      });
      // Images
      let images = [];
      const blockParent = $(block).parent().parent();
      const imageNodes = blockParent.find('button[data-photos-src]');
      if (imageNodes && imageNodes.length) {
        imageNodes.each((_, img) => images.push($(img).attr('data-photos-src')));
      }
      let score = null;
      const scoreElm = blockParent.find('div.bui-review-score__badge');
      if (scoreElm.length) {
        score = Number($(scoreElm).text().trim().replace(',0', ''));
      }
      if (good || bad) {
        let lang = null;
        const span = $(block).find('span[lang]');
        if (span.length) lang = span.attr('lang');
        return { bad, good, lang, images, score };
      } else {
        return null;
      }
    }).get();
  } catch (error) {
    return null;
  }
}

function chunkByCharLimit(texts) {
  const CHAR_LIMIT = 10000;
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;
  for (const text of texts) {
    const textLength = encodeURIComponent(text).length;
    if (currentLength + textLength > CHAR_LIMIT) {
      if (currentChunk.length > 0) chunks.push(currentChunk);
      currentChunk = [text];
      currentLength = textLength;
    } else {
      currentChunk.push(text);
      currentLength += textLength;
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

async function translateBatch(texts, sourceLang) {
  const SEPARATOR = '\uE000';
  const joinedText = texts.join(` ${SEPARATOR} `);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=en&dt=t&q=${encodeURIComponent(joinedText)}`;
  const res = await fetch(url);
  const data = await res.json();
  const translatedJoined = data[0].map(part => part[0]).join('');
  const translations = translatedJoined.split(SEPARATOR).map(t => t.trim());
  return translations;
}

async function translateAll(reviews, sourceLang) {
  const chunks = chunkByCharLimit(reviews);
  const translatedChunks = await Promise.all(
    chunks.map(chunk => translateBatch(chunk, sourceLang))
  );
  return translatedChunks.flat();
}

async function translateTexts(texts) {
  const langMap = new Map();
  texts.forEach(({ text, lang }) => {
    if (!langMap.has(lang)) langMap.set(lang, []);
    langMap.get(lang).push(text);
  });
  const groupped = [...langMap];
  const translatedGroupped = await Promise.all(
    groupped.map(async ([lang, texts]) => {
      if (lang === 'en' || lang === 'en-us') return [lang, texts];
      return [lang, await translateAll(texts, lang)];
    })
  );
  return translatedGroupped.flatMap(([lang, texts]) => texts.map(text => ({ lang, text })));
}

function getCountryFromLanguageCode(lang) {
  lang = lang.toUpperCase();
  const map = {
    'EN': 'English',
    'EN-US': 'English',
    'PT-BR': 'Brazil',
    'EL': 'Greece',
    'JA': 'Japan',
    'DA': 'Denmark',
    'KO': 'South Korea',
    'XM': 'Unknown',
    'HE': 'Israel',
    'ZH': 'China',
    'ZH-TW': 'Taiwan',
    'ES-AR': 'Argentina',
  };
  if (map[lang]) return map[lang];
  return lang;
}

function getPhotos(reviews) {
  const photos = {};
  reviews.forEach(item => {
    if (!item.images?.length) return;
    if (!photos[item.score]) photos[item.score] = [];
    photos[item.score].push(...item.images);
  });
  return photos;
}

async function getHotelSummary(reviews) {
  const negatives = reviews.filter(item => !!item.bad || !!item.good).map(item => {
    if (item.bad && item.good) {
      return [
        { text: item.good, lang: item.lang, images: item.images, score: item.score },
        { text: item.bad, lang: item.lang, images: item.images, score: item.score },
      ];
    } else if (item.bad) {
      return [
        { text: item.bad, lang: item.lang, images: item.images, score: item.score },
      ];
    } else if (item.good) {
      return [
        { text: item.good, lang: item.lang, images: item.images, score: item.score },
      ];
    }
  }).flat();
  const translated = await translateTexts(negatives);
  // Move dash-like characters to the end/escape for proper regex
  const latinRegex = /^[A-Za-z0-9\s.,!?'"’“”:;()\-–—]+$/;
  const englishReviews = translated.filter(r => latinRegex.test(r.text));
  const summary = {
    bedbug: [],
    cockroach: [],
    silverfish: [],
    mold: [],
    theft: [],
    insect: [],
  };
  englishReviews.forEach(item => {
    const newItem = {
      text: item.text,
      country: getCountryFromLanguageCode(item.lang),
    };
    if (item.text.toLowerCase().includes('bedbug')) summary.bedbug.push(newItem);
    if (
      item.text.toLowerCase().includes('cockroach') ||
      (item.text.toLowerCase().includes('roach') && !item.text.toLowerCase().includes('approach') && !item.text.toLowerCase().includes('reproach'))
    ) summary.cockroach.push(newItem);
    if (item.text.toLowerCase().includes('mold')) summary.mold.push(newItem);
    if (
      item.text.toLowerCase().includes('stole') ||
      item.text.toLowerCase().includes('steal') ||
      item.text.toLowerCase().includes('thief') ||
      item.text.toLowerCase().includes('theft') ||
      item.text.toLowerCase().includes('robbery') ||
      item.text.toLowerCase().includes('robbed')
    ) summary.theft.push(newItem);
    if (item.text.toLowerCase().includes('insect')) summary.insect.push(newItem);
    if (item.text.toLowerCase().includes('silver') && item.text.toLowerCase().includes('fish')) summary.silverfish.push(newItem);
  });
  const photos = getPhotos(reviews);
  return { summary, photos };
}

// Endpoint /summary теперь контролирует сессию для каждого запроса
app.get('/summary', async (req, res) => {
  const { hotel, country } = req.query;
  if (!hotel || !country) {
    res.status(400).json({ error: 'Missing hotel or country parameter' });
    return;
  }
  try {
    // Получаем pages и cookies ОДНИМ вызовом
    const { pages, sessionCookie } = await getReviewsPages(country, hotel);
    // Передаем свежую cookie дальше, только для этого запроса
    const reviews = await getReviews(country, hotel, pages, sessionCookie);
    const result = await getHotelSummary(reviews);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error fetching hotel summary' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
