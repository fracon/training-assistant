'use strict';

const SUBDIVISIONS = {
  BR: [
    ['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá', 'Amapa'], ['AM', 'Amazonas'],
    ['BA', 'Bahia'], ['CE', 'Ceará', 'Ceara'], ['DF', 'Distrito Federal', 'Federal District'],
    ['ES', 'Espírito Santo', 'Espirito Santo'], ['GO', 'Goiás', 'Goias'], ['MA', 'Maranhão', 'Maranhao'],
    ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'], ['MG', 'Minas Gerais'], ['PA', 'Pará', 'Para'],
    ['PB', 'Paraíba', 'Paraiba'], ['PR', 'Paraná', 'Parana'], ['PE', 'Pernambuco'], ['PI', 'Piauí', 'Piaui'],
    ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'], ['RS', 'Rio Grande do Sul'],
    ['RO', 'Rondônia', 'Rondonia'], ['RR', 'Roraima'], ['SC', 'Santa Catarina'],
    ['SP', 'São Paulo', 'Sao Paulo'], ['SE', 'Sergipe'], ['TO', 'Tocantins'],
  ],
  US: [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
    ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'],
    ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
    ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
    ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
    ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'],
    ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
    ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'],
    ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'],
    ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
    ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
    ['DC', 'District of Columbia'],
  ],
};

function normalizeSubdivisionText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function isKnownAdministrativeAbbreviation(value) {
  const abbreviation = normalizeSubdivisionText(value).toUpperCase();
  return /^[A-Z]{2}$/.test(abbreviation) && Object.values(SUBDIVISIONS)
    .some((regions) => regions.some(([code]) => code === abbreviation));
}

function resolveAdministrativeSubdivision(value, countryCode) {
  const abbreviation = normalizeSubdivisionText(value).toUpperCase();
  if (!isKnownAdministrativeAbbreviation(abbreviation)) return null;
  const country = String(countryCode ?? '').trim().toUpperCase();
  const subdivision = SUBDIVISIONS[country]?.find(([code]) => code === abbreviation);
  if (!subdivision) return null;
  return {
    countryCode: country,
    code: subdivision[0],
    names: subdivision.slice(1).map(normalizeSubdivisionText),
  };
}

function matchesAdministrativeSubdivision(fields, subdivision) {
  if (!subdivision || !Array.isArray(fields)) return false;
  return fields.some((field) => {
    const normalizedField = normalizeSubdivisionText(field);
    return subdivision.names.some((name) => normalizedField === name ||
      normalizedField.startsWith(`${name} `) || normalizedField.includes(` ${name} `) ||
      normalizedField.endsWith(` ${name}`));
  });
}

module.exports = {
  isKnownAdministrativeAbbreviation,
  resolveAdministrativeSubdivision,
  matchesAdministrativeSubdivision,
};
