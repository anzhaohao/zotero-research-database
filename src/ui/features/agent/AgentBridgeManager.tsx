import { useEffect, useRef, useState } from "react";
import { MinerUConfigurationPanel } from "./MinerUConfigurationPanel";
import { mineruModeLabel } from "./agentLabels";
import type { ResearchRepository } from "../../../storage/repository";
import { PrimaryPdfManager, usePrimaryPdfRows } from "../pdf/PrimaryPdfManager";
import {
  MinerUConversionService,
  type MinerUProgress,
  type MinerUProfile,
  readMinerUProfile,
} from "../../../services/mineru";
import { openResearchPreferences } from "../../preferencesNavigation";
import { Modal } from "../shared/ui";

export function AgentBridgeManager({
  repository,
  initialTab,
  items,
  onArtifactsImported,
  onClose,
}: {
  repository: ResearchRepository;
  initialTab: "mineru" | "pdf";
  items: Zotero.Item[];
  onArtifactsImported: () => Promise<void>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const [savedMode, setSavedMode] = useState<MinerUProfile["mode"]>();
  const { pdfRows, reloadPdfRows } = usePrimaryPdfRows(items, repository);
  const [mineruProgress, setMineruProgress] = useState<
    Map<string, MinerUProgress>
  >(new Map());
  const [mineruRunning, setMineruRunning] = useState(false);
  const [mineruImporting, setMineruImporting] = useState(false);
  const [toolTab, setToolTab] = useState<"mineru" | "pdf">(initialTab);
  const mineruServiceRef = useRef<MinerUConversionService | undefined>(
    undefined,
  );

  useEffect(() => {
    const refreshSavedMode = () => {
      try {
        setSavedMode(readMinerUProfile().mode);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    };
    refreshSavedMode();
    const mainWindow = Zotero.getMainWindow();
    mainWindow?.addEventListener("focus", refreshSavedMode);
    return () => mainWindow?.removeEventListener("focus", refreshSavedMode);
  }, []);

  const runMinerU = async (targets: Zotero.Item[]): Promise<void> => {
    if (!targets.length || mineruServiceRef.current) return;
    let profile: MinerUProfile;
    try {
      profile = readMinerUProfile();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return;
    }
    const service = new MinerUConversionService(profile);
    mineruServiceRef.current = service;
    setSavedMode(profile.mode);
    setMineruRunning(true);
    setMineruImporting(false);
    setMineruProgress(new Map());
    setStatus(
      `正在使用 ${mineruModeLabel(profile.mode)} 转换 ${targets.length} 篇论文……`,
    );
    try {
      await service.run(targets, (entry) => {
        setMineruImporting(
          entry.state === "running" &&
            entry.message.includes("正在导入 Zotero"),
        );
        setMineruProgress((current) => {
          const next = new Map(current);
          next.set(entry.itemKey, entry);
          return next;
        });
      });
      await onArtifactsImported();
      setStatus("MinerU 队列已结束；Markdown 与图表已刷新到对应条目");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setMineruRunning(false);
      setMineruImporting(false);
      mineruServiceRef.current = undefined;
    }
  };

  const requestCancel = () => {
    const service = mineruServiceRef.current;
    if (!service) return;
    if (service.isImporting() || mineruImporting) {
      setStatus("当前正在导入 Zotero，无法取消；请等待导入完成");
      return;
    }
    setStatus("正在取消 MinerU 任务……");
    void service.cancel();
  };

  const requestClose = () => {
    if (!mineruRunning) {
      onClose();
      return;
    }
    requestCancel();
  };

  return (
    <Modal title="文献处理" onClose={requestClose} wide>
      <nav className="zrdb-tool-tabs" aria-label="当前文献处理">
        {(
          [
            ["mineru", "MinerU 转换"],
            ["pdf", `主 PDF · ${items.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            className={toolTab === id ? "is-active" : ""}
            aria-pressed={toolTab === id}
            key={id}
            onClick={() => setToolTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {toolTab === "mineru" && (
        <MinerUConfigurationPanel
          modeLabel={savedMode ? mineruModeLabel(savedMode) : "读取已保存配置"}
          desktopMode={savedMode === "local-client"}
          items={items}
          mineruRunning={mineruRunning}
          mineruImporting={mineruImporting}
          runMinerU={runMinerU}
          mineruProgress={mineruProgress}
          onCancel={requestCancel}
          onOpenSettings={() => {
            void openResearchPreferences("mineru").catch((error) =>
              setStatus(error instanceof Error ? error.message : String(error)),
            );
          }}
        />
      )}
      {toolTab === "pdf" && (
        <PrimaryPdfManager
          items={items}
          repository={repository}
          pdfRows={pdfRows}
          reloadPdfRows={reloadPdfRows}
          running={mineruRunning}
          onStatus={setStatus}
          onConvert={(item) => {
            setToolTab("mineru");
            void runMinerU([item]);
          }}
        />
      )}
      {status && (
        <p className="zrdb-status" role="status">
          {status}
        </p>
      )}
      <div className="zrdb-dialog-actions">
        <button className="primary" onClick={requestClose}>
          {mineruRunning ? "取消并等待完成" : "完成"}
        </button>
      </div>
    </Modal>
  );
}
