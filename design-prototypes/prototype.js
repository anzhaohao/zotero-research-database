const variantNames = {
  notion: "A · Notion 清爽",
  apple: "B · Apple 玻璃",
  academic: "C · 学术工作台",
};

const columns = [
  { id: "preview", label: "PDF 首页", width: 126 },
  { id: "title", label: "文献标题", width: 338 },
  { id: "basic", label: "基础信息", width: 374 },
  { id: "question", label: "研究问题", width: 292 },
  { id: "meaning", label: "研究意义", width: 286 },
  { id: "method", label: "研究方法", width: 270 },
  { id: "result", label: "主要成果", width: 308 },
  { id: "note", label: "我的批注", width: 246 },
];

const papers = [
  {
    key: "P01",
    title: "冷冻辅助光丝击穿光谱的水中重金属元素检测",
    translatedTitle: "",
    file: "冷冻辅助LIBS_中译.pdf",
    authors: "祁琪，张明远，李一鸣",
    year: "2025",
    journal: "中国激光",
    institution: "吉林大学 · 电子科学与工程学院",
    doi: "10.3788/CJL250420",
    quartiles: ["北核", "CSCD 核心库", "EI"],
    citation:
      "祁琪, 张明远, 李一鸣. 冷冻辅助光丝击穿光谱的水中重金属元素检测[J]. 中国激光, 2025.",
    question:
      "如何降低水环境对激光诱导击穿光谱的淬灭效应，并提升痕量重金属元素的检测稳定性？",
    meaning:
      "为复杂水样的原位、快速重金属监测提供更稳定的光谱采集路径，减少传统前处理步骤。",
    method:
      "通过冻结水样构建固态界面，比较不同延迟时间与激光能量下的谱线强度、信噪比和重复性。",
    result:
      "冻结处理显著提高特征谱线强度与重复性；在优化参数下获得更低检出限，并验证多元素检测能力。",
    note: "重点核对冻结温度、样本盐度与检出限之间的关系。后续可与液面约束方案横向比较。",
  },
  {
    key: "P02",
    title: "Frequency-resolved optical gating using second-harmonic generation",
    translatedTitle: "使用二次谐波产生的频率分辨光学门控",
    file: "FROG_SHG_original.pdf",
    authors: "Rick Trebino, Daniel J. Kane",
    year: "1993",
    journal: "Journal of the Optical Society of America A",
    institution: "Sandia National Laboratories",
    doi: "10.1364/JOSAA.10.001101",
    quartiles: ["SCI", "JCR Q2", "光学"],
    citation:
      "Trebino, R., & Kane, D. J. (1993). Using phase retrieval to measure the intensity and phase of ultrashort pulses. JOSA A, 10(5), 1101–1111.",
    question:
      "如何利用二维非线性光谱同时恢复超短激光脉冲的时间强度与相位，并避免传统自相关测量的歧义？",
    meaning:
      "建立可完整表征超短脉冲电场的通用测量框架，为色散诊断、压缩优化和非线性光学实验提供基础。",
    method:
      "采用二次谐波产生构造频率分辨光学门，通过迭代相位恢复算法从二维迹图重建时域脉冲。",
    result:
      "证明二维迹图包含充分的相位信息，并给出具有冗余约束、可自校验的脉冲恢复方法。",
    note: "这篇适合作为 FROG 算法与实验结构的源头文献；需要单独整理迭代算法的约束条件。",
  },
  {
    key: "P03",
    title: "基于脉冲压缩的飞秒激光时域表征与误差分析",
    translatedTitle: "",
    file: "飞秒脉冲表征.pdf",
    authors: "王晨，赵子航，刘洋",
    year: "2024",
    journal: "光学学报",
    institution: "中国科学院西安光学精密机械研究所",
    doi: "10.3788/AOS231987",
    quartiles: ["北核", "CSCD 核心库", "EI"],
    citation:
      "王晨, 赵子航, 刘洋. 基于脉冲压缩的飞秒激光时域表征与误差分析[J]. 光学学报, 2024, 44(8): 0814002.",
    question:
      "脉冲压缩链路中的色散、噪声和采样误差如何共同影响超短脉冲重建精度？",
    meaning:
      "为实验室脉冲压缩调试提供可量化的误差预算，帮助区分硬件误差与重建算法误差。",
    method:
      "组合仿真与实验，对群延迟色散、光谱噪声和时间采样间隔进行单因素及联合敏感性分析。",
    result:
      "给出不同脉宽区间的主要误差来源与推荐采样参数，并提出一套分阶段校准流程。",
    note: "可直接借鉴误差预算表格；需要确认其噪声模型是否适合本项目相机。",
  },
  {
    key: "P04",
    title:
      "Deep-learning-assisted retrieval of ultrashort laser pulses from noisy traces",
    translatedTitle: "深度学习辅助的含噪迹图超短激光脉冲恢复",
    file: "DL_FROG_retrieval.pdf",
    authors: "M. Chen, A. Silva, K. Ito",
    year: "2023",
    journal: "Optics Express",
    institution: "University of Rochester",
    doi: "10.1364/OE.487210",
    quartiles: ["SCI", "JCR Q1", "Top"],
    citation:
      "Chen, M., Silva, A., & Ito, K. (2023). Deep-learning-assisted retrieval of ultrashort laser pulses from noisy traces. Optics Express, 31(14), 22810–22825.",
    question:
      "轻量神经网络能否在低信噪比 FROG 迹图上加速脉冲恢复，同时维持物理一致性？",
    meaning:
      "缩短在线诊断时间，并探索数据驱动先验与传统物理迭代之间更稳健的协同方式。",
    method:
      "使用合成迹图预训练卷积网络，再以物理前向模型计算的一致性损失进行微调与筛选。",
    result:
      "在中低噪声下显著减少迭代次数；极端噪声时仍需物理优化校正，纯网络输出不可直接替代。",
    note: "适合作为轻量 Agent 的候选思路，但训练数据分布偏理想，需警惕域偏移。",
  },
];

const state = {
  selectedColumn: "basic",
  activeCell: null,
  pinnedColumn: "",
  columnOrder: columns.map((column) => column.id),
  coloredCells: new Set(),
  editingCell: null,
  sortDirection: "desc",
  citationStyle: "zotero",
};

const app = document.querySelector("[data-prototype-app]");
const variant = document.body.dataset.theme || "notion";

function icon(name) {
  return `<span class="mi-icon" aria-hidden="true">${name}</span>`;
}

function uiIcon(name) {
  const shapes = {
    list: '<path d="M6.5 5h10M6.5 10h10M6.5 15h10"></path><circle cx="3.2" cy="5" r=".7"></circle><circle cx="3.2" cy="10" r=".7"></circle><circle cx="3.2" cy="15" r=".7"></circle>',
    table:
      '<rect x="2.5" y="3" width="15" height="14" rx="2"></rect><path d="M2.5 7.7h15M7.5 7.7V17m5-9.3V17"></path>',
    cards:
      '<rect x="2.5" y="3" width="6.2" height="6" rx="1.3"></rect><rect x="11.3" y="3" width="6.2" height="6" rx="1.3"></rect><rect x="2.5" y="11" width="6.2" height="6" rx="1.3"></rect><rect x="11.3" y="11" width="6.2" height="6" rx="1.3"></rect>',
    arrange:
      '<path d="M4 5h12M4 10h8M4 15h5"></path><path d="m14 12 2.5 3L19 12m-2.5 3V6"></path>',
    fields:
      '<rect x="2.5" y="3" width="15" height="14" rx="2"></rect><path d="M7.5 3v14M2.5 8h15M12.5 8v9"></path>',
    views:
      '<path d="M4 3h8.5L16 6.5V17H4z"></path><path d="M12.5 3v3.5H16M7 10h6M7 13h4"></path>',
    theme:
      '<circle cx="10" cy="10" r="3.2"></circle><path d="M10 2v2M10 16v2M2 10h2m12 0h2M4.3 4.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4"></path>',
    edit: '<path d="m4 14.8.7-3.3L13.8 2.4a1.4 1.4 0 0 1 2 0l1.8 1.8a1.4 1.4 0 0 1 0 2l-9.1 9.1zM12.7 3.5l3.8 3.8M3 18h14"></path>',
    copy: '<rect x="6.2" y="6.2" width="9.3" height="9.3" rx="1.8"></rect><path d="M4.2 12.8h-.5A1.7 1.7 0 0 1 2 11.1V4.7A2.7 2.7 0 0 1 4.7 2h6.4a1.7 1.7 0 0 1 1.7 1.7v.5"></path>',
    color:
      '<path d="m10 2.5 5.2 6.2a5.6 5.6 0 1 1-10.4 0z"></path><path d="M6.7 12.5a3.3 3.3 0 0 0 3.3 3.3"></path>',
    check: '<path d="m3.5 10.5 4 4 9-9"></path>',
    open: '<path d="M7 4H4v12h12v-3M10 3h7v7M17 3l-8 8"></path>',
  };
  return `<svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">${shapes[name] || ""}</svg>`;
}

function menuMarkup() {
  const pinOptions = columns
    .map(
      (column) =>
        `<option value="${column.id}" ${state.pinnedColumn === column.id ? "selected" : ""}>${column.label}</option>`,
    )
    .join("");
  return `
    <div class="menu-wrap">
      <button class="menu-trigger" data-menu-trigger data-tooltip="排列：排序、分组与升降序" aria-label="排列：排序、分组与升降序" aria-expanded="false">${uiIcon("arrange")}</button>
      <div class="menu" role="menu">
        <h3>排序</h3>
        <div class="menu-select"><label>排序字段</label><select data-demo-control><option>年份</option><option>标题</option><option>期刊</option><option>研究问题</option></select></div>
        <button class="menu-item" data-action="direction">${icon("⇅")}<span>升降序</span><small data-direction-label>降序</small></button>
        <div class="menu-separator"></div>
        <h3>分组</h3>
        <div class="menu-select"><label>分组字段</label><select data-demo-control><option>不分组</option><option>期刊分区</option><option>年份</option><option>研究方法</option></select></div>
      </div>
    </div>
    <div class="menu-wrap">
      <button class="menu-trigger" data-menu-trigger data-tooltip="字段、列与外部工具" aria-label="字段、列与外部工具" aria-expanded="false">${uiIcon("fields")}</button>
      <div class="menu" role="menu">
        <h3>数据库字段</h3>
        <button class="menu-item" data-action="field-manager">${icon("▦")}<span>管理自定义字段</span><small>8 个</small></button>
        <button class="menu-item" data-action="new-field">${icon("＋")}<span>新增字段</span></button>
        <button class="menu-item" data-action="column-layout">${icon("↔")}<span>列显示与宽度</span></button>
        <div class="menu-separator"></div>
        <h3>定位与外部工具</h3>
        <div class="menu-select"><label>临时固定</label><select data-pin-select><option value="">不固定</option>${pinOptions}</select></div>
        <button class="menu-item" data-action="external-agent">${icon("⌘")}<span>外部 Agent / 工具</span><small>本机</small></button>
      </div>
    </div>
    <div class="menu-wrap">
      <button class="menu-trigger" data-menu-trigger data-tooltip="视图、引用与导出" aria-label="视图、引用与导出" aria-expanded="false">${uiIcon("views")}</button>
      <div class="menu" role="menu">
        <h3>视图</h3>
        <button class="menu-item" data-action="save-view">${icon("◇")}<span>保存当前视图</span><small>Ctrl S</small></button>
        <button class="menu-item" data-action="load-view">${icon("◫")}<span>读取已保存视图</span><small>4 个</small></button>
        <button class="menu-item" data-action="update-view">${icon("↻")}<span>更新“论文精读”</span></button>
        <div class="menu-separator"></div>
        <h3>引用</h3>
        <div class="menu-select"><label>引用格式</label><select data-citation-style><option value="zotero">Zotero 当前样式</option><option value="gbt">GB/T 7714</option><option value="apa">APA 7</option><option value="nature">Nature</option><option value="ieee">IEEE</option></select></div>
        <div class="menu-separator"></div>
        <h3>导出当前表格</h3>
        <button class="menu-item" data-action="export-xlsx">${icon("X")}<span>Excel（保留背景色）</span></button>
        <button class="menu-item" data-action="export-csv">${icon("C")}<span>CSV</span></button>
        <button class="menu-item" data-action="export-html">${icon("H")}<span>HTML / PDF</span></button>
      </div>
    </div>`;
}

function citationText(paper) {
  if (state.citationStyle === "gbt")
    return `${paper.authors}. ${paper.title}[J]. ${paper.journal}, ${paper.year}.`;
  if (state.citationStyle === "apa")
    return `${paper.authors}. (${paper.year}). ${paper.title}. ${paper.journal}. https://doi.org/${paper.doi}`;
  if (state.citationStyle === "nature")
    return `${paper.authors}. ${paper.title}. ${paper.journal} (${paper.year}).`;
  if (state.citationStyle === "ieee")
    return `${paper.authors}, “${paper.title},” ${paper.journal}, ${paper.year}.`;
  return paper.citation;
}

function copyIcon() {
  return uiIcon("copy");
}

function basicInfo(paper) {
  const tags = paper.quartiles
    .map(
      (tag, index) =>
        `<span class="quartile ${index === 0 ? "hot" : ""}">${tag}</span>`,
    )
    .join("");
  return `<div class="basic-info">
    <div class="meta-line"><span class="label">作者</span><span class="value">${paper.authors}</span></div>
    <div class="meta-line"><span class="label">年份</span><span class="value">${paper.year}</span></div>
    <div class="meta-line"><span class="label">期刊</span><span class="value">${paper.journal}</span></div>
    <div class="meta-line"><span class="label">机构</span><span class="value">${paper.institution}</span></div>
    <div class="meta-line"><span class="label">DOI</span><span class="value">${paper.doi}</span></div>
    <div class="quartiles">${tags}</div>
    <div class="citation-row">
      <div class="citation" data-citation-text>${citationText(paper)}</div>
      <button class="citation-copy" type="button" data-citation-copy title="复制引用" aria-label="复制引用">${copyIcon()}</button>
    </div>
  </div>`;
}

function preview(paper) {
  return `<div class="pdf-preview" title="双击：按 Zotero 默认逻辑打开 PDF">
    <b>${paper.title.slice(0, 27)}</b>
    <span class="pdf-line"></span><span class="pdf-line"></span><span class="pdf-line" style="width:78%"></span>
    <span class="pdf-line"></span><span class="pdf-line" style="width:67%"></span>
  </div>`;
}

function cellContent(column, paper) {
  if (column.id === "preview") return preview(paper);
  if (column.id === "title") {
    return `<div class="paper-title"><strong>${paper.title}</strong>${paper.translatedTitle ? `<span class="translated-title">${paper.translatedTitle}</span>` : ""}</div>`;
  }
  if (column.id === "basic") return basicInfo(paper);
  const content = paper[column.id];
  const prefixes = {
    question: "问题",
    meaning: "价值",
    method: "方法",
    result: "结论",
    note: "批注",
  };
  return `<div class="research-text" data-editable-content><strong>${prefixes[column.id]}：</strong>${content}</div>`;
}

function actions(column) {
  if (column.id === "preview") {
    return `<div class="cell-actionbar"><button class="primary" data-cell-action="open" data-tooltip="打开 PDF" aria-label="打开 PDF">${uiIcon("open")}</button></div>`;
  }
  const editable = !["basic"].includes(column.id);
  return `<div class="cell-actionbar">
    ${editable ? `<button class="primary" data-cell-action="edit" data-tooltip="编辑" aria-label="编辑">${uiIcon("edit")}</button>` : ""}
    <button data-cell-action="copy" data-tooltip="复制内容" aria-label="复制内容">${uiIcon("copy")}</button>
    <button data-cell-action="color" data-tooltip="设置背景色" aria-label="设置背景色">${uiIcon("color")}</button>
  </div>`;
}

function orderedColumns() {
  const base = state.columnOrder
    .map((id) => columns.find((column) => column.id === id))
    .filter(Boolean);
  const pinned = columns.find((column) => column.id === state.pinnedColumn);
  if (!pinned) return base;
  return [pinned, ...base.filter((column) => column.id !== pinned.id)];
}

function tableMarkup() {
  const ordered = orderedColumns();
  const header = ordered
    .map(
      (
        column,
      ) => `<div class="table-cell ${state.selectedColumn === column.id ? "is-column-selected" : ""} ${state.pinnedColumn === column.id ? "is-pinned" : ""}" style="--cell-width:${column.width}px" data-column="${column.id}" data-drag-column="${column.id}" draggable="true">
        <span class="column-grip" title="拖动调整列顺序">⠿</span><span>${column.label}</span><span class="pin-mark">● 固定</span>
      </div>`,
    )
    .join("");
  const rows = papers
    .map(
      (paper) => `<div class="table-row" data-paper="${paper.key}">
        ${ordered
          .map((column) => {
            const cellKey = `${paper.key}:${column.id}`;
            const classes = [
              "table-cell",
              column.id === "preview" ? "preview-cell" : "",
              state.selectedColumn === column.id ? "is-column-selected" : "",
              state.activeCell === cellKey ? "is-active" : "",
              state.pinnedColumn === column.id ? "is-pinned" : "",
              state.coloredCells.has(cellKey) ? "is-colored" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `<div class="${classes}" style="--cell-width:${column.width}px" data-column="${column.id}" data-cell="${cellKey}">
              ${cellContent(column, paper)}${actions(column)}
            </div>`;
          })
          .join("")}
      </div>`,
    )
    .join("");
  return `<div class="research-table"><div class="table-row table-header">${header}</div>${rows}</div>`;
}

function appMarkup() {
  return `<div class="app">
    <div class="ambient"></div>
    <header class="topbar">
      <div class="title-row">
        <div class="database-mark">▦</div>
        <div class="database-title"><h1>论文精读数据库</h1><p>当前集合 · 超快光学与光谱分析 · 4 篇</p></div>
        <span class="prototype-badge">${variantNames[variant]}</span>
        <div class="spacer"></div>
        <div class="view-switcher" aria-label="视图切换"><button data-tooltip="默认列表" aria-label="默认列表">${uiIcon("list")}</button><button class="active" data-tooltip="数据库表格" aria-label="数据库表格">${uiIcon("table")}</button><button data-tooltip="文献卡片" aria-label="文献卡片">${uiIcon("cards")}</button></div>
        <button class="icon-button" data-theme-toggle data-tooltip="切换明暗模式" aria-label="切换明暗模式">${uiIcon("theme")}</button>
      </div>
      <div class="action-row">
        <div class="search-wrap"><input type="search" placeholder="筛选当前文献和研究字段" aria-label="筛选文献"></div>
        <div class="spacer"></div>
        ${menuMarkup()}
        <div class="status-chip"><span class="status-dot"></span>Zotero 元数据 · 已同步</div>
      </div>
    </header>
    <main class="workspace"><div class="table-scroll" data-table-scroll>${tableMarkup()}</div></main>
    <div class="toast" role="status" aria-live="polite"></div>
  </div>`;
}

function closeMenus(except) {
  document.querySelectorAll(".menu-wrap.open").forEach((wrap) => {
    if (wrap !== except) {
      wrap.classList.remove("open");
      wrap
        .querySelector("[data-menu-trigger]")
        ?.setAttribute("aria-expanded", "false");
    }
  });
}

let toastTimer;
function toast(message) {
  const element = document.querySelector(".toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 1800);
}

function refreshTable({ preserveScroll = true } = {}) {
  const scroll = document.querySelector("[data-table-scroll]");
  const left = preserveScroll ? scroll.scrollLeft : 0;
  const top = preserveScroll ? scroll.scrollTop : 0;
  scroll.innerHTML = tableMarkup();
  scroll.scrollLeft = left;
  scroll.scrollTop = top;
}

function reorderColumn(fromID, toID, placeAfter) {
  if (!fromID || !toID || fromID === toID) return;
  const order = state.columnOrder.filter((id) => id !== fromID);
  const targetIndex = order.indexOf(toID);
  if (targetIndex < 0) return;
  order.splice(targetIndex + (placeAfter ? 1 : 0), 0, fromID);
  state.columnOrder = order;
  state.activeCell = null;
  refreshTable();
  toast(`已移动“${columns.find((column) => column.id === fromID)?.label}”列`);
}

function clearDropIndicators() {
  document
    .querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after")
    .forEach((element) =>
      element.classList.remove(
        "is-dragging",
        "is-drop-before",
        "is-drop-after",
      ),
    );
}

function selectColumn(columnID) {
  state.selectedColumn = columnID;
  state.activeCell = null;
  state.editingCell = null;
  document
    .querySelectorAll(".table-cell.is-column-selected, .table-cell.is-active")
    .forEach((cell) =>
      cell.classList.remove("is-column-selected", "is-active"),
    );
  document
    .querySelectorAll(`[data-column="${columnID}"]`)
    .forEach((cell) => cell.classList.add("is-column-selected"));
}

function copyCell(cell) {
  const text = cell.innerText
    .replace(/编辑|完成|复制|填色|打开 PDF/g, "")
    .trim();
  if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(text).catch(() => {});
  toast("已复制当前单元格的纯文本");
}

function copyCitation(button) {
  const text = button
    .closest(".citation-row")
    ?.querySelector("[data-citation-text]")
    ?.textContent?.trim();
  if (!text) return;
  if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(text).catch(() => {});
  toast("已复制当前引用");
}

function setEditButtonState(button, editing) {
  const label = editing ? "完成编辑" : "编辑";
  button.innerHTML = uiIcon(editing ? "check" : "edit");
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
}

function handleAction(action, element) {
  const cell = element.closest("[data-cell]");
  if (action === "edit" && cell) {
    const content = cell.querySelector(
      "[data-editable-content], .paper-title strong",
    );
    const editing = state.editingCell === cell.dataset.cell;
    if (editing) {
      content?.removeAttribute("contenteditable");
      state.editingCell = null;
      setEditButtonState(element, false);
      toast("演示：字段已完成编辑并锁定");
    } else {
      content?.setAttribute("contenteditable", "true");
      content?.focus();
      state.editingCell = cell.dataset.cell;
      setEditButtonState(element, true);
      toast("编辑态已开启，点击“完成”退出");
    }
    return;
  }
  if (action === "copy" && cell) return copyCell(cell);
  if (action === "color" && cell) {
    const key = cell.dataset.cell;
    state.coloredCells.has(key)
      ? state.coloredCells.delete(key)
      : state.coloredCells.add(key);
    refreshTable();
    toast(state.coloredCells.has(key) ? "已添加柔和背景色" : "已清除背景色");
    return;
  }
  if (action === "open") return toast("演示：将调用 Zotero 默认 PDF 打开逻辑");
  const messages = {
    direction: `排序方向已切换为${state.sortDirection === "desc" ? "升序" : "降序"}`,
    "field-manager": "演示：打开字段管理器",
    "new-field": "演示：新增自定义字段与提示词",
    "column-layout": "演示：打开列显示、别名与尺寸设置",
    "external-agent": "演示：打开外部 Agent / 工具适配器",
    "save-view": "演示：当前列顺序、固定列与筛选已保存",
    "load-view": "演示：打开已保存视图管理",
    "update-view": "演示：已更新“论文精读”视图",
    "export-xlsx": "演示：导出 Excel（保留语义背景色）",
    "export-csv": "演示：导出当前可见列为 CSV",
    "export-html": "演示：生成 HTML，并可打印为 PDF",
  };
  if (action === "direction") {
    state.sortDirection = state.sortDirection === "desc" ? "asc" : "desc";
    document.querySelector("[data-direction-label]").textContent =
      state.sortDirection === "desc" ? "降序" : "升序";
  }
  toast(messages[action] || "这是视觉原型中的交互示意");
}

app.innerHTML = appMarkup();

let draggingColumnID = "";
let suppressClickUntil = 0;

document.addEventListener("dragstart", (event) => {
  const header = event.target.closest("[data-drag-column]");
  if (!header) return;
  draggingColumnID = header.dataset.dragColumn;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggingColumnID);
  requestAnimationFrame(() => header.classList.add("is-dragging"));
});

document.addEventListener("dragover", (event) => {
  const target = event.target.closest("[data-drag-column]");
  if (
    !target ||
    !draggingColumnID ||
    target.dataset.dragColumn === draggingColumnID
  )
    return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document
    .querySelectorAll(".is-drop-before, .is-drop-after")
    .forEach((element) =>
      element.classList.remove("is-drop-before", "is-drop-after"),
    );
  const rect = target.getBoundingClientRect();
  target.classList.add(
    event.clientX >= rect.left + rect.width / 2
      ? "is-drop-after"
      : "is-drop-before",
  );
});

document.addEventListener("drop", (event) => {
  const target = event.target.closest("[data-drag-column]");
  if (!target || !draggingColumnID) return;
  event.preventDefault();
  const placeAfter = target.classList.contains("is-drop-after");
  const fromID = draggingColumnID;
  draggingColumnID = "";
  suppressClickUntil = performance.now() + 180;
  clearDropIndicators();
  reorderColumn(fromID, target.dataset.dragColumn, placeAfter);
});

document.addEventListener("dragend", () => {
  draggingColumnID = "";
  clearDropIndicators();
});

document.addEventListener("pointerdown", (event) => {
  const trigger = event.target.closest("[data-menu-trigger]");
  if (trigger) {
    const wrap = trigger.closest(".menu-wrap");
    const next = !wrap.classList.contains("open");
    closeMenus(wrap);
    wrap.classList.toggle("open", next);
    trigger.setAttribute("aria-expanded", String(next));
    return;
  }
  if (!event.target.closest(".menu")) closeMenus();
});

document.addEventListener("click", (event) => {
  if (performance.now() < suppressClickUntil) return;
  const citationCopy = event.target.closest("[data-citation-copy]");
  if (citationCopy) {
    event.stopPropagation();
    copyCitation(citationCopy);
    return;
  }
  const toggle = event.target.closest("[data-theme-toggle]");
  if (toggle) {
    document.body.classList.toggle("is-dark");
    toast(
      document.body.classList.contains("is-dark")
        ? "已切换为暗夜模式"
        : "已切换为明亮模式",
    );
    return;
  }
  const actionElement = event.target.closest(
    "[data-action], [data-cell-action]",
  );
  if (actionElement) {
    event.stopPropagation();
    handleAction(
      actionElement.dataset.action || actionElement.dataset.cellAction,
      actionElement,
    );
    return;
  }
  const cell = event.target.closest("[data-column]");
  if (cell && !event.target.closest("select")) {
    selectColumn(cell.dataset.column);
    toast(
      `已选中整列：${columns.find((column) => column.id === state.selectedColumn)?.label}`,
    );
  }
});

document.addEventListener("dblclick", (event) => {
  const cell = event.target.closest("[data-cell]");
  if (!cell) return;
  event.preventDefault();
  event.stopPropagation();
  state.activeCell = cell.dataset.cell;
  state.selectedColumn = cell.dataset.column;
  document
    .querySelectorAll(".table-cell.is-active")
    .forEach((entry) => entry.classList.remove("is-active"));
  cell.classList.add("is-active");
  if (cell.dataset.column === "preview")
    toast("已激活首页预览；再次点击“打开 PDF”进入原文");
});

document.addEventListener("change", (event) => {
  const citationStyle = event.target.closest("[data-citation-style]");
  if (citationStyle) {
    state.citationStyle = citationStyle.value;
    refreshTable();
    toast(`引用格式已切换为“${citationStyle.selectedOptions[0].textContent}”`);
    return;
  }
  const select = event.target.closest("[data-pin-select]");
  if (select) {
    state.pinnedColumn = select.value;
    state.activeCell = null;
    refreshTable({ preserveScroll: false });
    toast(
      select.value
        ? `已将“${columns.find((column) => column.id === select.value)?.label}”临时固定到第一列`
        : "已取消固定列",
    );
    closeMenus();
    return;
  }
  if (event.target.closest("[data-demo-control]"))
    toast("排列设置已在原型中记录");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenus();
    if (state.activeCell) {
      state.activeCell = null;
      state.editingCell = null;
      refreshTable();
    }
  }
});
