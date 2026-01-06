import { Plugin, PluginSettingTab, Setting, MarkdownPostProcessorContext, setTooltip, App } from 'obsidian';
import * as child_process from 'child_process';

interface CommitDetail {
	hash: string;
	message: string;
	author: string;
	date: string;
}

interface GitHeatmapSettings {
	defaultDays: number;
}

const DEFAULT_SETTINGS: GitHeatmapSettings = {
	defaultDays: 365
};

// GitHub 风格绿色系
const PALETTE = {
	light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
	dark: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"]
};

export default class GitHeatmapPlugin extends Plugin {
	settings: GitHeatmapSettings;

	// ✅ 当前激活的格子
	activeRect: SVGElement | null = null;

	// ✅ keyboard navigation state
	private gridRects: (SVGRectElement | undefined)[][] = [];
	private gridMeta: ({ dateStr: string; count: number } | undefined)[][] = [];
	private currentPos = { row: 0, col: 0 };
	private keyHandler: ((ev: KeyboardEvent) => void) | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new GitHeatmapSettingTab(this.app, this));
		this.registerMarkdownCodeBlockProcessor("git-heatmap", (source, el, ctx) => {
			this.processHeatmap(source, el, ctx);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async processHeatmap(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const wrapper = el.createDiv({ cls: "git-heatmap-plugin-wrapper" });

		// 1. 热力图区域
		const scrollArea = wrapper.createDiv({ cls: "git-heatmap-scroll-area" });

		// 2. 信息显示区域
		const infoArea = wrapper.createDiv({ cls: "git-commit-info-area" });

		// 初始状态：显示提示
		infoArea.createDiv({ cls: "info-placeholder", text: "Select a square" });

		let displayDays = this.settings.defaultDays;
		const lines = source.split('\n');
		for (const line of lines) {
			const parts = line.split(':');
			if (parts.length === 2 && ['days', 'day'].includes(parts[0].trim().toLowerCase())) {
				const parsed = parseInt(parts[1].trim());
				if (!isNaN(parsed) && parsed > 0) displayDays = parsed;
			}
		}

		try {
			const adapter = this.app.vault.adapter as any;
			if (!adapter.getBasePath) throw new Error("无法获取 Vault 路径");
			const basePath = adapter.getBasePath();

			const gitLog = await this.getGitLog(basePath, displayDays);
			const stats = this.parseGitLog(gitLog);

			this.renderHeatmap(scrollArea, infoArea, stats, basePath, displayDays);

		} catch (error: any) {
			scrollArea.empty();
			scrollArea.createEl('div', { text: `⚠️ ${error.message}`, cls: 'error-notice' });
		}
	}

	async getGitLog(cwd: string, days: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const date = new Date();
			date.setDate(date.getDate() - days);
			const sinceDate = date.toISOString().split('T')[0];
			const cmd = `git log --since="${sinceDate}" --date=short --format="%ad"`;
			child_process.exec(cmd, { cwd }, (err, stdout) => {
				if (err && !stdout) { reject(new Error("No Git Log")); return; }
				resolve(stdout || "");
			});
		});
	}

	parseGitLog(log: string): Map<string, number> {
		const lines = log.split('\n').filter(l => l.trim());
		const stats = new Map<string, number>();
		lines.forEach(date => {
			const cleanDate = date.trim();
			stats.set(cleanDate, (stats.get(cleanDate) || 0) + 1);
		});
		return stats;
	}

	renderHeatmap(
		container: HTMLElement,
		infoContainer: HTMLElement,
		stats: Map<string, number>,
		basePath: string,
		displayDays: number
	) {
		const isDarkMode = document.body.classList.contains('theme-dark');
		const colors = isDarkMode ? PALETTE.dark : PALETTE.light;

		const blockSize = 12;
		const blockGap = 2;
		const marginX = 25;
		const marginY = 20;

		// ✅ reset caches per render
		this.gridRects = [];
		this.gridMeta = [];

		const startDate = new Date();
		startDate.setDate(startDate.getDate() - displayDays + 1);
		const startDayOfWeek = startDate.getDay();

		const totalWeeks = Math.ceil((displayDays + startDayOfWeek) / 7);
		const fullWidth = totalWeeks * (blockSize + blockGap) + marginX * 2;
		const fullHeight = 7 * (blockSize + blockGap) + marginY + 25;

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'git-heatmap-svg');
		svg.setAttribute('width', `${fullWidth}`);
		svg.setAttribute('height', `${fullHeight}`);
		container.appendChild(svg);

		const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		group.setAttribute('transform', `translate(${marginX}, ${marginY})`);
		svg.appendChild(group);

		// ✅ unified selection logic (click + keyboard)
		const selectCell = (row: number, col: number) => {
			const rect = this.gridRects?.[row]?.[col];
			const meta = this.gridMeta?.[row]?.[col];
			if (!rect || !meta) return;

			if (this.activeRect) this.activeRect.classList.remove('active-selected');
			rect.classList.add('active-selected');
			this.activeRect = rect;
			this.currentPos = { row, col };

			// ✅ auto scroll into view
			rect.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });

			this.updateInfoArea(infoContainer, meta.dateStr, meta.count, basePath);
		};

		// --- 星期标签 ---
		const weekLabels = { 1: 'Mon', 3: 'Wed', 5: 'Fri' };
		Object.keys(weekLabels).forEach((idxStr) => {
			const index = parseInt(idxStr);
			const label = weekLabels[index as keyof typeof weekLabels];
			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.textContent = label;
			text.setAttribute('x', '-5');
			text.setAttribute('y', `${index * (blockSize + blockGap) + blockSize - 2}`);
			text.setAttribute('text-anchor', 'end');
			text.setAttribute('class', 'heatmap-label');
			group.appendChild(text);
		});

		// --- 格子与月份 ---
		let lastMonth = -1;
		for (let i = 0; i < displayDays; i++) {
			const currentDate = new Date(startDate);
			currentDate.setDate(startDate.getDate() + i);

			const row = currentDate.getDay();
			const col = Math.floor((i + startDayOfWeek) / 7);

			// ensure 2D arrays exist
			if (!this.gridRects[row]) this.gridRects[row] = [];
			if (!this.gridMeta[row]) this.gridMeta[row] = [];

			const currentMonth = currentDate.getMonth();
			if (((col === 0 && i === 0) || (row === 0)) && currentMonth !== lastMonth) {
				const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
				const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				text.textContent = monthNames[currentMonth];
				text.setAttribute('x', `${col * (blockSize + blockGap)}`);
				text.setAttribute('y', '-6');
				text.setAttribute('class', 'heatmap-label');
				group.appendChild(text);
				lastMonth = currentMonth;
			}

			const dateStr = currentDate.toISOString().split('T')[0];
			const count = stats.get(dateStr) || 0;

			let level = 0;
			if (count > 0) level = 1;
			if (count > 3) level = 2;
			if (count > 6) level = 3;
			if (count > 10) level = 4;

			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', `${col * (blockSize + blockGap)}`);
			rect.setAttribute('y', `${row * (blockSize + blockGap)}`);
			rect.setAttribute('width', `${blockSize}`);
			rect.setAttribute('height', `${blockSize}`);
			rect.setAttribute('rx', '2');
			rect.setAttribute('fill', colors[level]);
			rect.setAttribute('class', 'heatmap-rect');

			// store rect/meta
			this.gridRects[row][col] = rect;
			this.gridMeta[row][col] = { dateStr, count };

			setTooltip(rect as unknown as HTMLElement, `${dateStr}: ${count} commits`);

			rect.addEventListener('click', (e) => {
				e.stopPropagation();
				selectCell(row, col);
			});

			group.appendChild(rect);
		}

		// --- Legend (Less ... More) ---
		const legendGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		const legendWidth = (colors.length * (blockSize + blockGap)) + 60;
		const legendX = fullWidth - marginX - legendWidth + 20;
		const legendY = fullHeight - 5;

		const textLess = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		textLess.textContent = "Less";
		textLess.setAttribute('x', `${legendX + 15}`);
		textLess.setAttribute('y', `${legendY - 3}`);
		textLess.setAttribute('text-anchor', 'end');
		textLess.setAttribute('class', 'heatmap-label');
		legendGroup.appendChild(textLess);

		colors.forEach((c, idx) => {
			const lRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			lRect.setAttribute('x', `${legendX + 20 + idx * (blockSize + blockGap)}`);
			lRect.setAttribute('y', `${legendY - blockSize}`);
			lRect.setAttribute('width', `${blockSize}`);
			lRect.setAttribute('height', `${blockSize}`);
			lRect.setAttribute('rx', '2');
			lRect.setAttribute('fill', c);
			legendGroup.appendChild(lRect);
		});

		const textMore = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		textMore.textContent = "More";
		textMore.setAttribute('x', `${legendX + 20 + colors.length * (blockSize + blockGap) + 5}`);
		textMore.setAttribute('y', `${legendY - 3}`);
		textMore.setAttribute('class', 'heatmap-label');
		legendGroup.appendChild(textMore);

		svg.appendChild(legendGroup);

		// ✅ remove old key handler to avoid stacking
		if (this.keyHandler) {
			window.removeEventListener("keydown", this.keyHandler);
		}

		// ✅ keyboard navigation
		this.keyHandler = (ev: KeyboardEvent) => {
			const active = document.activeElement as HTMLElement | null;
			const tag = active?.tagName?.toLowerCase();
			if (tag === "input" || tag === "textarea" || active?.isContentEditable) return;

			const { row, col } = this.currentPos;
			let newRow = row;
			let newCol = col;

			if (ev.key === "ArrowUp") newRow = Math.max(0, row - 1);
			else if (ev.key === "ArrowDown") newRow = Math.min(6, row + 1);
			else if (ev.key === "ArrowLeft") newCol = Math.max(0, col - 1);
			else if (ev.key === "ArrowRight") newCol = Math.min(totalWeeks - 1, col + 1);
			else return;

			ev.preventDefault();

			if (newRow !== row || newCol !== col) {
				selectCell(newRow, newCol);
			}
		};

		window.addEventListener("keydown", this.keyHandler);

		// ✅ default select the last week column (closest to today)
		selectCell(startDayOfWeek, totalWeeks - 1);
	}

	async updateInfoArea(container: HTMLElement, dateStr: string, count: number, basePath: string) {
		container.empty();

		// --- 头部信息 ---
		const header = container.createDiv({ cls: "info-header-right" });
		header.createSpan({ cls: "info-date", text: dateStr });

		// ✅ 0 contributions 自动加 zero class（配合 CSS 灰色）
		header.createSpan({
			cls: `info-count-badge ${count === 0 ? "zero" : ""}`,
			text: `${count} contributions`
		});

		if (count === 0) return;

		// --- 列表容器 ---
		const list = container.createDiv({ cls: "commit-list-right" });
		list.setText("Loading...");

		try {
			const commits = await this.getCommitsForDate(basePath, dateStr);
			list.empty();

			commits.forEach(c => {
				const item = list.createDiv({ cls: "commit-item-right" });

				item.createDiv({ cls: "item-msg", text: c.message });

				const meta = item.createDiv({ cls: "item-meta" });
				const timeStr = c.date.split('T')[1]?.substring(0, 5) || "";

				meta.createSpan({ cls: "meta-val", text: timeStr });
				meta.createSpan({ cls: "meta-sep", text: "·" });
				meta.createSpan({ cls: "meta-val font-mono", text: c.hash.substring(0, 7) });
			});
		} catch (e) {
			list.setText("Error loading details");
		}
	}

	async getCommitsForDate(cwd: string, date: string): Promise<CommitDetail[]> {
		return new Promise((resolve) => {
			const separator = "§§§";
			const cmd = `git log --after="${date} 00:00:00" --before="${date} 23:59:59" --format="%H${separator}%s${separator}%an${separator}%aI" --date=iso`;
			child_process.exec(cmd, { cwd }, (err, stdout) => {
				if (err || !stdout) { resolve([]); return; }
				const commits: CommitDetail[] = [];
				stdout.split('\n').forEach(line => {
					if (!line.trim()) return;
					const parts = line.split(separator);
					if (parts.length >= 4) {
						commits.push({ hash: parts[0], message: parts[1], author: parts[2], date: parts[3] });
					}
				});
				resolve(commits);
			});
		});
	}
}

class GitHeatmapSettingTab extends PluginSettingTab {
	plugin: GitHeatmapPlugin;
	constructor(app: App, plugin: GitHeatmapPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Default Days').addText(text =>
			text.setValue(String(this.plugin.settings.defaultDays)).onChange(async (v) => {
				this.plugin.settings.defaultDays = parseInt(v) || 365;
				await this.plugin.saveSettings();
			})
		);
	}
}