import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readmePath = resolve(__dirname, '../README.md');

const USERNAME = 'sx4im';
const EXCLUDED_REPOS = ['emmabostian/developer-portfolios'];
const token = process.env.GITHUB_TOKEN;

const headers = {
  'User-Agent': 'sx4im-readme-updater',
  'Accept': 'application/vnd.github+json',
  ...(token ? { Authorization: `Bearer ${token}` } : {})
};

function formatStars(stars) {
  if (stars >= 1000) {
    const k = (stars / 1000).toFixed(1).replace(/\.0$/, '');
    return `${k}k`;
  }
  return `${stars}`;
}

async function fetchMergedPRs() {
  const prs = [];
  let totalCount = 0;
  const excludedQuery = EXCLUDED_REPOS.map(r => `-repo:${r}`).join(' ');
  const query = `author:${USERNAME} is:pr is:merged -user:${USERNAME}${excludedQuery ? ' ' + excludedQuery : ''}`;

  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`GitHub search API error (${res.status} ${res.statusText}): ${errorText}`);
    }
    const data = await res.json();
    totalCount = data.total_count ?? totalCount;
    const items = data.items || [];
    if (items.length === 0) break;
    prs.push(...items);
    if (prs.length >= totalCount) break;
  }

  const filteredPrs = prs.filter(pr => !EXCLUDED_REPOS.some(repo => pr.repository_url.endsWith(`/${repo}`)));

  // Sort newest first by merged_at (fallback to closed_at)
  filteredPrs.sort((a, b) => {
    const timeA = new Date(a.pull_request?.merged_at || a.closed_at || 0).getTime();
    const timeB = new Date(b.pull_request?.merged_at || b.closed_at || 0).getTime();
    return timeB - timeA;
  });

  return filteredPrs;
}

async function fetchRepoDetails(repoMap) {
  const repoEntries = await Promise.all(
    Array.from(repoMap.entries()).map(async ([apiUrl, repoPrs]) => {
      try {
        const res = await fetch(apiUrl, { headers });
        if (!res.ok) {
          console.warn(`Failed to fetch repo ${apiUrl}: ${res.status} ${res.statusText}`);
          const fallbackName = apiUrl.replace('https://api.github.com/repos/', '');
          return {
            fullName: fallbackName,
            htmlUrl: `https://github.com/${fallbackName}`,
            stars: 0,
            prs: repoPrs
          };
        }
        const data = await res.json();
        return {
          fullName: data.full_name,
          htmlUrl: data.html_url,
          stars: data.stargazers_count ?? 0,
          prs: repoPrs
        };
      } catch (err) {
        console.warn(`Error fetching repo ${apiUrl}:`, err);
        const fallbackName = apiUrl.replace('https://api.github.com/repos/', '');
        return {
          fullName: fallbackName,
          htmlUrl: `https://github.com/${fallbackName}`,
          stars: 0,
          prs: repoPrs
        };
      }
    })
  );

  // Repos sorted by stars descending
  repoEntries.sort((a, b) => {
    if (b.stars !== a.stars) {
      return b.stars - a.stars;
    }
    if (b.prs.length !== a.prs.length) {
      return b.prs.length - a.prs.length;
    }
    return a.fullName.localeCompare(b.fullName);
  });

  return repoEntries;
}

function pullsUrl(fullName) {
  return `https://github.com/${fullName}/pulls?q=is%3Apr+author%3A${USERNAME}+is%3Amerged`;
}

function generateMarkdown(prs, repoMap, topRepos) {
  const countLine = `${prs.length} merged prs across ${repoMap.size} repos`;

  const tableHeader = '| repo | stars | merged |\n|:--|--:|--:|';
  const tableRows = topRepos.map(repo => {
    const [owner] = repo.fullName.split('/');
    const repoPullsUrl = pullsUrl(repo.fullName);
    const avatar = `<a href="${repoPullsUrl}"><img src="https://wsrv.nl/?url=https://github.com/${owner}.png&w=40&h=40&fit=cover&mask=circle&output=png" width="20" height="20" align="absmiddle"></a>`;
    const arrow = `<a href="${repoPullsUrl}"><img src="https://api.iconify.design/lucide:arrow-up-right.svg?color=%238b949e" width="14" height="14" alt="my prs in ${repo.fullName}" align="absmiddle"></a>`;
    return `| ${avatar}&nbsp;<b>${repo.fullName}</b>&nbsp;${arrow} | ${formatStars(repo.stars)} | ${repo.prs.length} |`;
  });
  const table = `${tableHeader}\n${tableRows.join('\n')}`;

  return `${countLine}\n\n${table}`;
}

async function main() {
  const prs = await fetchMergedPRs();

  const repoMap = new Map();
  for (const pr of prs) {
    const repoUrl = pr.repository_url;
    if (!repoMap.has(repoUrl)) {
      repoMap.set(repoUrl, []);
    }
    repoMap.get(repoUrl).push(pr);
  }

  const topRepos = await fetchRepoDetails(repoMap);
  const generatedContent = generateMarkdown(prs, repoMap, topRepos);

  const readme = readFileSync(readmePath, 'utf8');
  const startMarker = '<!-- oss:start -->';
  const endMarker = '<!-- oss:end -->';

  const startIndex = readme.indexOf(startMarker);
  const endIndex = readme.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    throw new Error(`Could not find valid oss markers in ${readmePath}`);
  }

  const before = readme.slice(0, startIndex + startMarker.length);
  const after = readme.slice(endIndex);
  const updatedReadme = `${before}\n${generatedContent}\n${after}`;

  if (updatedReadme !== readme) {
    writeFileSync(readmePath, updatedReadme, 'utf8');
    console.log(`Updated ${readmePath} between markers.`);
  } else {
    console.log('No changes needed; README.md is already up to date.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
