export function createLearningSources(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'learning-sources';

  const heading = document.createElement('h2');
  heading.textContent = 'Learning sources';

  const sources = document.createElement('ul');
  const entries = [
    {
      title: 'FAA Pilot’s Handbook of Aeronautical Knowledge, Chapter 16: Navigation',
      url: 'https://www.faa.gov/sites/faa.gov/files/18_phak_ch16.pdf#page=12',
      context: 'Printed pages 16-12–21, especially Figure 16-26 (16-20), cover route charting, recognizable checkpoints, wind correction and headings, groundspeed, time, fuel, and estimated versus actual flight-log observations.'
    },
    {
      title: 'FAA Aeronautical Information Manual, Chapter 7, Section 1: Meteorology',
      url: 'https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap7_section_1.html',
      context: 'Sections 7-1-2 and 7-1-3 explain airport surface observations, observations versus forecasts, currency and relevance, and why selected products are not a full weather briefing.'
    },
    {
      title: 'FAA Aviation Weather Handbook (FAA-H-8083-28A)',
      url: 'https://www.faa.gov/sites/faa.gov/files/FAA-H-8083-28A_FAA_Web.pdf#page=297',
      context: 'Section 24.4 (printed page 24-5 onward) covers METAR/SPECI surface observations; Section 27.2 (page 27-3 onward) covers winds and temperatures aloft forecasts.'
    }
  ];

  for (const entry of entries) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = entry.url;
    link.textContent = entry.title;
    const context = document.createElement('p');
    context.textContent = entry.context;
    item.append(link, context);
    sources.append(item);
  }

  const assumptions = document.createElement('p');
  assumptions.className = 'worksheet-assumptions';
  const assumptionsLabel = document.createElement('strong');
  assumptionsLabel.textContent = 'Worksheet assumptions: ';
  assumptions.append(assumptionsLabel, document.createTextNode('one cruise altitude; departure METAR surface wind for initial climb; winds aloft at estimated TOC for the following cruise row; destination cruise-altitude forecast to estimate TOD and reuse for descent. These are teaching-tool assumptions, not FAA-prescribed methods. Forecasts and generated points are estimates, and selected inputs do not constitute a complete preflight briefing.'));

  section.append(heading, sources, assumptions);
  return section;
}
