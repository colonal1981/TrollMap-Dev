import asyncio
from playwright.async_api import async_playwright

LAKES = {
    'allatoona':        'https://storymaps.arcgis.com/stories/1c82b6c519b44e858ddd028d1bbf3453',
    'andrews':          'https://storymaps.arcgis.com/stories/fc5805e439f4450f8357c034d18eceda',
    'bartletts-ferry':  'https://storymaps.arcgis.com/stories/7e01e1a18ced4ec9a6f87c82f2272ab0',
    'big-haynes':       'https://storymaps.arcgis.com/stories/78ba13fb45f9473da55fd158373c13d5',
    'blackshear':       'https://storymaps.arcgis.com/stories/264b93843af042e7a7151299976b8c6e',
    'blue-ridge':       'https://storymaps.arcgis.com/stories/32c7542965e541eca756d51bae4eb1ec',
    'burton':           'https://storymaps.arcgis.com/stories/ba62c611af9844d48ae9076c313ae1be',
    'carters':          'https://storymaps.arcgis.com/stories/195c66b92a4042ffa4b37ed41fff81e2',
    'chatuge':          'https://storymaps.arcgis.com/stories/181a1ddac0604430907644e0c6ba03a8',
    'chehaw':           'https://storymaps.arcgis.com/stories/3e6c6f8606064eabba4227c72ea5d26b',
    'clarks-hill':      'https://storymaps.arcgis.com/stories/8442bc9ff43f4b5c96ad11acb9ee3ac6',
    'goat-rock':        'https://storymaps.arcgis.com/stories/1350b65f93654c819cbc27c959e35abe',
    'hamburg':          'https://storymaps.arcgis.com/stories/89e71b9a4123430c8caaaf53b2625bfc',
    'hartwell':         'https://storymaps.arcgis.com/stories/ea1839811a2b4c6e83df03bc51b81f7a',
    'high-falls':       'https://storymaps.arcgis.com/stories/47808a182728419d987c5e973c398abc',
    'jackson':          'https://storymaps.arcgis.com/stories/6f492807b19c45c08bd86f7cc8498acf',
    'juliette':         'https://storymaps.arcgis.com/stories/9abb6dfa0f8041aba3a8896d428010ea',
    'lanier':           'https://storymaps.arcgis.com/stories/bf90dbefc6d34795a96fdc0181e746d9',
    'nottely':          'https://storymaps.arcgis.com/stories/f138a47e2c4d4cab9a51b3c32058af5d',
    'oconee':           'https://storymaps.arcgis.com/stories/e7d44ce4bc054728b6ab131b2b8d98e9',
    'oliver':           'https://storymaps.arcgis.com/stories/6e0b57e6dd444e8a97a6e315dcf32d38',
    'rabun':            'https://storymaps.arcgis.com/stories/1b23a8aeaa3646ebae427378d828a19c',
    'russell':          'https://storymaps.arcgis.com/stories/bdbfa9d911fe417dacfdd056bbf6783f',
    'seed':             'https://storymaps.arcgis.com/stories/a224d457ae9f419282d85a76a5b553b4',
    'seminole':         'https://storymaps.arcgis.com/stories/6b329ae238da4c948f36418c9d1ced25',
    'sinclair':         'https://storymaps.arcgis.com/stories/5c863ec0b0534e998d3217fd13ac1a62',
    'tobesofkee':       'https://storymaps.arcgis.com/stories/bb30deb0d39b442bb5c72f5cbfd1b0ce',
    'tugalo':           'https://storymaps.arcgis.com/stories/6f69ad0336374853ac63dd480d781d0b',
    'walter-f-george':  'https://storymaps.arcgis.com/stories/22343e9a63f04e5e95fd0dc8abc2d3af',
    'west-point':       'https://storymaps.arcgis.com/stories/a019d774757344c5adfc91a3dd5f73db',
    'yonah':            'https://storymaps.arcgis.com/stories/e1bd005e7d554223ac7604387456e713',
}

OUTPUT_DIR = 'Georgia_Lakes'

async def fetch_lake(page, name, url):
    print(f'Fetching {name}...')
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=60000)
        # Wait for story content to render
        await page.wait_for_selector('text=Prospect', timeout=45000)
        content = await page.content()
        path = f'{OUTPUT_DIR}/{name}.html'
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'  ✓ Saved {name}')
    except Exception as e:
        print(f'  ✗ Failed {name}: {e}')

async def main():
    import os
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        for name, url in LAKES.items():
            await fetch_lake(page, name, url)
            await asyncio.sleep(2)  # polite delay
        await browser.close()

asyncio.run(main())
