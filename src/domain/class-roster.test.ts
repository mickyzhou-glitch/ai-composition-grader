import { describe, expect, it } from "vitest";
import {
  cleanSingleStudentName,
  computeClassSubmissionBreakdown,
  formatMissingRosterCopyText,
  normalizeStudentNameForMatch,
  parseMultiClassRosterText,
  parseRosterStudentText,
  upsertClassRostersInputSchema,
} from "./class-roster";

describe("class-roster domain", () => {
  it("normalizes CJK padded two-character names while preserving English spaces and multi-name lines", () => {
    expect(cleanSingleStudentName("01. 张　三")).toBe("张三");
    expect(cleanSingleStudentName("01. 张　小明")).toBe("张小明");
    expect(cleanSingleStudentName("02. 欧阳　修")).toBe("欧阳修");
    expect(cleanSingleStudentName("（2）王 伟")).toBe("王伟");
    expect(cleanSingleStudentName("3、欧阳修")).toBe("欧阳修");
    expect(cleanSingleStudentName("4. Tom  Lee")).toBe("Tom Lee");
    expect(normalizeStudentNameForMatch("张　三")).toBe("张三");
    expect(normalizeStudentNameForMatch("欧 阳 修")).toBe("欧阳修");
    expect(normalizeStudentNameForMatch("Anna  May")).toBe("Anna May");

    // 单行空格分隔多个二字姓名及同行带序号全角空格姓名绝不误拆或误拼
    const singleLineMulti = parseRosterStudentText("丁一 王五 李四");
    expect(singleLineMulti.students).toEqual(["丁一", "王五", "李四"]);
    expect(parseRosterStudentText("1. 张　三 2. 李　小明").students).toEqual(["张三", "李小明"]);
    expect(cleanSingleStudentName("张\u0000三")).toBe("张三");

    // 教务表逐行粘贴（含表头、学号列、全角空格对齐与重复项）
    const tablePaste = parseRosterStudentText([
      "序号\t学生姓名",
      "01\t张　三",
      "02\t李四",
      "03\t欧阳修",
      "4. 张三",
      "5、王五、赵六，孙七",
      "Tom Lee",
    ].join("\n"));
    expect(tablePaste.students).toEqual(["张三", "李四", "欧阳修", "王五", "赵六", "孙七", "Tom Lee"]);
    expect(tablePaste.duplicateNames).toEqual(["张三"]);
  });

  it("parses multi-class Excel/CSV two-column and three-column pastes", () => {
    const parsed = parseMultiClassRosterText([
      "序号\t班级\t姓名",
      "1\t六（1）班\t张　三",
      "2\t六（1）班\t李四",
      "3\t六（2）班\t王五",
      "六（2）班,赵六",
      "无效单列行",
    ].join("\n"));

    expect(parsed.skippedLines).toBe(1);
    expect(parsed.rosters).toEqual([
      { className: "六（1）班", students: ["张三", "李四"], duplicateCount: 0 },
      { className: "六（2）班", students: ["王五", "赵六"], duplicateCount: 0 },
    ]);
  });

  it("computes submitted, missing, rejected/draft notes, unnamed count, and unmatched names accurately", () => {
    const roster = ["张三", "李四", "王五", "赵六", "孙七"];
    const breakdown = computeClassSubmissionBreakdown("六（1）班", roster, [
      { id: "r-zhang", className: "六（1）班", studentName: "张　三", status: "ready_for_review", teacherReviewedAt: "2026-11-26T10:00:00Z" },
      { id: "r-li-new", className: "六（1）班", studentName: "李四", status: "rejected", teacherReviewedAt: null },
      { id: "r-wang", className: "六（1）班", studentName: "王五", status: "draft", teacherReviewedAt: null },
      { id: "r-blank", className: "六（1）班", studentName: "   ", status: "analyzing", teacherReviewedAt: null },
      { id: "r-typo", className: "六（1）班", studentName: "赵柳", status: "ready_for_review", teacherReviewedAt: null },
      { id: "r-other-class", className: "六（2）班", studentName: "孙七", status: "exported", teacherReviewedAt: "2026-11-26T10:00:00Z" },
    ]);

    expect(breakdown.totalRoster).toBe(5);
    expect(breakdown.submitted.map((item) => item.name)).toEqual(["张三", "李四", "王五"]);
    expect(breakdown.missing).toEqual(["赵六", "孙七"]);
    expect(breakdown.rejectedNames).toEqual(["李四"]);
    expect(breakdown.draftNames).toEqual(["王五"]);
    expect(breakdown.unnamedSubmissionCount).toBe(1);
    expect(breakdown.unmatchedSubmissions).toEqual([
      { studentName: "赵柳", reviewId: "r-typo", status: "ready_for_review" },
    ]);

    expect(formatMissingRosterCopyText({
      className: "六（1）班",
      title: "为自己鼓掌",
      missing: breakdown.missing,
    })).toBe("六（1）班《为自己鼓掌》未交名单（2人）：赵六、孙七");
    expect(formatMissingRosterCopyText({
      className: "六（1）班",
      title: "为自己鼓掌",
      missing: breakdown.missing,
      namesOnly: true,
    })).toBe("赵六、孙七");
  });

  it("validates single and multi-class upsert payloads with Zod", () => {
    const single = upsertClassRostersInputSchema.parse({
      className: " 六（1）/A班 ",
      students: ["1. 张　三", "李四", "张三"],
    });
    expect(single).toEqual({
      rosters: [{ className: "六（1）/A班", students: ["张三", "李四"] }],
      mode: "replace",
    });

    expect(() => upsertClassRostersInputSchema.parse({ className: "   ", students: ["张三"] })).toThrow();
    expect(() => upsertClassRostersInputSchema.parse({ className: "六（1）班", students: [] })).toThrow();
  });
});
