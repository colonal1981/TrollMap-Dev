// research/drawdown.js — split from worker-research.js (behavior-preserving)

const DUKE_CRA_PDFS = {
  wateree:           'https://www.duke-energy.com/-/media/pdfs/community/wateree-agreement.pdf?rev=d3ee54ead58f4919960633f9b2c0a3f2',
  wylie:             'https://www.duke-energy.com/-/media/pdfs/community/wylie-agreement.pdf?rev=b1ccd83257274304a043a97d94474e5f',
  norman:            'https://www.duke-energy.com/-/media/pdfs/community/norman-agreement.pdf?rev=df2002c7986b43dabfdf4ef347b3d029',
  rhodhiss:          'https://www.duke-energy.com/-/media/pdfs/community/rhodiss-agreement.pdf?rev=3d518189847e4d4fadc621264286adba',
  'mountain island': 'https://www.duke-energy.com/-/media/pdfs/community/mtislefacsht.pdf?rev=4318d49fff6449c290ddd4affcd37c1e',
  hickory:           'https://www.duke-energy.com/-/media/pdfs/community/hickory-agreement.pdf?rev=4e0097e227a745a49e27dfe9db53aff7',
  james:             'https://www.duke-energy.com/-/media/pdfs/community/james-agreement.pdf?rev=e2633e78f0104d8896fbcc35b245f13a',
  'lookout shoals':  'https://www.duke-energy.com/-/media/pdfs/community/lookout-shoals.pdf?rev=063151e074d048b599cc83e8e07ab301',
  'fishing creek':   'https://www.duke-energy.com/-/media/pdfs/community/fishing-creek.pdf?rev=76777a1c22734366b74f2315e63d62ef',
  'great falls':     'https://www.duke-energy.com/-/media/pdfs/community/gf-rocky-creek.pdf?rev=2627ab82b93c4fdc85dd1b4e9b49ef61',
  'rocky creek':     'https://www.duke-energy.com/-/media/pdfs/community/gf-rocky-creek.pdf?rev=2627ab82b93c4fdc85dd1b4e9b49ef61',
};

const OWNER_DRAWDOWN_SOURCES = {
  dukeEnergy: {
    label: 'Duke Energy Catawba-Wateree License Agreement & Lake Summaries',
    url: 'https://www.duke-energy.com/community/lakes/hydroelectric-relicensing/catawba/license-agreement',
    authority: 'Duke Energy / FERC',
    type: 'HTML'
  },
  usaceSavannah: {
    label: 'USACE Savannah District Water Control / Lake Operations',
    url: 'https://www.sas.usace.army.mil/Missions/Water-Control/',
    authority: 'USACE Savannah District',
    type: 'HTML'
  },
  usaceWilmington: {
    label: 'USACE Wilmington District Water Control',
    url: 'https://www.saw.usace.army.mil/Missions/Water-Control/',
    authority: 'USACE Wilmington District',
    type: 'HTML'
  },
  usaceMobile: {
    label: 'USACE Mobile District Water Control',
    url: 'https://www.sam.usace.army.mil/Missions/Water-Control/',
    authority: 'USACE Mobile District',
    type: 'HTML'
  },
  tva: {
    label: 'Tennessee Valley Authority Reservoir Operations',
    url: 'https://www.tva.com/environment/lake-levels',
    authority: 'Tennessee Valley Authority',
    type: 'HTML'
  }
};

function resolveDrawdownSource(lakeName, state, reservoirOwner) {
  const owner = String(reservoirOwner || '').toLowerCase();
  const name = String(lakeName || '').toLowerCase();
  const baseName = name.replace(/^lake\s+/, '').replace(/,\s*(sc|nc|ga)(\/(sc|nc|ga))?\s*$/, '').trim();

  // Duke Energy owns Catawba-Wateree, Keowee-Toxaway, Nantahala, Yadkin-Pee Dee, etc.
  const dukeLakeNames = ['wateree','wylie','norman','keowee','jocassee','hickory','james','rhodhiss','mountain island','lookout shoals','fishing creek','great falls','cedar creek','dearborn','tillery','blewett falls'];
  if (owner.includes('duke energy') || owner.includes('duke power') || dukeLakeNames.some(l => baseName.includes(l))) {
    // Return per-lake CRA PDF if we have it, otherwise fall back to landing page
    const dukePdf = DUKE_CRA_PDFS[baseName] || Object.entries(DUKE_CRA_PDFS).find(([k]) => baseName.includes(k))?.[1];
    if (dukePdf) {
      return { label: `Duke Energy ${baseName} Lake Agreement Summary (pool levels, drawdown schedule)`, url: dukePdf, authority: 'Duke Energy / FERC', type: 'PDF' };
    }
    return OWNER_DRAWDOWN_SOURCES.dukeEnergy;
  }

  // TVA manages Tennessee Valley reservoirs.
  if (owner.includes('tennessee valley authority') || owner.includes('tva') || String(state || '').toUpperCase() === 'TN') {
    return OWNER_DRAWDOWN_SOURCES.tva;
  }

  // USACE lakes in the tristate region
  const savannahLakes = ['hartwell','russell','thurmond','clarks hill','clark hill','j strom thurmond','richard b. russell'];
  if (owner.includes('usace') || owner.includes('u.s. army corps') || owner.includes('army corps') || owner.includes('corps of engineers')) {
    if (savannahLakes.some(l => baseName.includes(l))) return OWNER_DRAWDOWN_SOURCES.usaceSavannah;
    if (['SC','GA'].includes(String(state || '').toUpperCase())) return OWNER_DRAWDOWN_SOURCES.usaceSavannah;
    if (['NC','VA'].includes(String(state || '').toUpperCase())) return OWNER_DRAWDOWN_SOURCES.usaceWilmington;
    return OWNER_DRAWDOWN_SOURCES.usaceSavannah;
  }

  return null;
}

export { DUKE_CRA_PDFS, OWNER_DRAWDOWN_SOURCES, resolveDrawdownSource };
