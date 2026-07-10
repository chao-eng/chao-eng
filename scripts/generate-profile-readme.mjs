import fs from "node:fs/promises";

const owner = process.env.PROFILE_USERNAME || "chao-eng";
const readmePath = new URL("../README.md", import.meta.url);
const apiBase = "https://api.github.com";
const featuredStart = "<!-- featured-projects:start -->";
const featuredEnd = "<!-- featured-projects:end -->";
const repoLimit = Number(process.env.PROFILE_REPO_LIMIT || 6);

async function githubRequest(path) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `${owner}-profile-readme-generator`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });

  return response;
}

async function fetchAllRepos() {
  const repos = [];

  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRequest(
      `/users/${owner}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch repositories: ${response.status} ${response.statusText}`,
      );
    }

    const pageRepos = await response.json();
    repos.push(...pageRepos);

    if (pageRepos.length < 100) {
      break;
    }
  }

  return repos.filter(
    (repo) =>
      !repo.fork &&
      !repo.archived &&
      !repo.disabled &&
      repo.name.toLowerCase() !== owner.toLowerCase(),
  );
}

function parseLastPage(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const parts = linkHeader.split(",");
  const lastPart = parts.find((part) => part.includes('rel="last"'));
  const nextPart = parts.find((part) => part.includes('rel="next"'));
  const target = lastPart || nextPart;

  if (!target) {
    return null;
  }

  const match = target.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : null;
}

async function fetchCommitCount(repoName) {
  const response = await githubRequest(
    `/repos/${owner}/${repoName}/commits?per_page=1`,
  );

  if (response.status === 409) {
    return 0;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch commits for ${repoName}: ${response.status} ${response.statusText}`,
    );
  }

  const linkHeader = response.headers.get("link");
  const pageCount = parseLastPage(linkHeader);

  if (pageCount) {
    return pageCount;
  }

  const commits = await response.json();
  return Array.isArray(commits) ? commits.length : 0;
}

function formatDescription(text) {
  if (!text) {
    return "暂无项目简介。";
  }

  return text.replace(/\r?\n/g, " ").trim();
}

function escapePipes(text) {
  return text.replace(/\|/g, "\\|");
}

async function buildFeaturedProjectsSection() {
  const repos = await fetchAllRepos();
  const rankedRepos = repos
    .sort((a, b) => {
      if (b.stargazers_count !== a.stargazers_count) {
        return b.stargazers_count - a.stargazers_count;
      }

      return new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime();
    })
    .slice(0, repoLimit);

  const reposWithCommits = await Promise.all(
    rankedRepos.map(async (repo) => ({
      ...repo,
      commitCount: await fetchCommitCount(repo.name),
    })),
  );

  if (reposWithCommits.length === 0) {
    return [
      "暂时还没有可展示的公开仓库。",
      "",
      "_以上内容由 GitHub Actions 自动更新。_",
    ].join("\n");
  }

  const lines = [
    "| 项目 | 简介 | 数据 |",
    "| --- | --- | --- |",
  ];

  for (const repo of reposWithCommits) {
    const description = escapePipes(formatDescription(repo.description));
    const stats = `⭐ ${repo.stargazers_count} · 提交 ${repo.commitCount}`;
    lines.push(`| [${repo.name}](${repo.html_url}) | ${description} | ${stats} |`);
  }

  lines.push("");
  lines.push("_以上内容由 GitHub Actions 自动更新。_");

  return lines.join("\n");
}

async function updateReadme() {
  const readme = await fs.readFile(readmePath, "utf8");
  const generatedSection = await buildFeaturedProjectsSection();
  const pattern = new RegExp(
    `${featuredStart}[\\s\\S]*?${featuredEnd}`,
    "m",
  );

  const replacement = `${featuredStart}\n${generatedSection}\n${featuredEnd}`;
  const nextReadme = readme.replace(pattern, replacement);

  if (nextReadme === readme) {
    return false;
  }

  await fs.writeFile(readmePath, nextReadme);
  return true;
}

updateReadme().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
