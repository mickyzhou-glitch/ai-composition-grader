import type { AssignmentConfig, ParagraphEvaluationReport } from "../domain/contracts";

export type BenchmarkThemeFit = ParagraphEvaluationReport["themeFit"];

export type BenchmarkScenarioCategory =
  | "cross_page"
  | "colloquial"
  | "off_topic_or_partial"
  | "grade_span"
  | "logic_check";

export interface QualityBenchmarkSample {
  id: string;
  fictional: true;
  label: string;
  category: BenchmarkScenarioCategory;
  config: AssignmentConfig;
  paragraphs: Array<{ id: string; text: string }>;
  /** 模拟跨页拍摄断裂发生在该段内部或段后，用于检验模型是否误判残句或漏读后文 */
  pageBreakNote?: string;
  teacherExpectations: {
    acceptableThemeFit: readonly BenchmarkThemeFit[];
    mustPreserveFacts: readonly string[];
    knownPitfalls: readonly string[];
    focusCheckpoints: readonly string[];
  };
}

/** 仅包含送入待测批改模型的纯粹输入，严格剥离教师预期、陷阱提示与人工核对点，防止评估泄露。 */
export interface BenchmarkModelInput {
  id: string;
  config: AssignmentConfig;
  paragraphs: Array<{ id: string; text: string }>;
}

export function exportBenchmarkModelInputs(
  samples: readonly QualityBenchmarkSample[] = QUALITY_BENCHMARK_SAMPLES,
): BenchmarkModelInput[] {
  return samples.map((sample) => ({
    id: sample.id,
    config: structuredClone(sample.config),
    paragraphs: sample.paragraphs.map(({ id, text }) => ({ id, text })),
  }));
}

/**
 * 12 篇纯虚构教学基准样文（不含任何真实学生姓名、学校或作文原件）。
 * 覆盖：小学四至初中九年级、跨页断行/名言跨行、口语流水账、偏题/半切题、生活常识矛盾与结构归组。
 */
export const QUALITY_BENCHMARK_SAMPLES: readonly QualityBenchmarkSample[] = [
  {
    id: "essay-01",
    fictional: true,
    label: "四年级·口语流水账《第一次洗碗》",
    category: "colloquial",
    config: {
      title: "第一次洗碗",
      grade: "小学四年级",
      writingRequirements: "写清楚洗碗的过程和自己的真实感受，语句通顺。",
      targetCharacters: 350,
      structureRequirements: "第1段：写为什么要洗碗。\n第2段：写洗碗遇到的麻烦和解决过程。\n第3段：写洗完后的心情。",
      scoringFocus: "过程清楚、动作真实、符合四年级语言水平。",
      templateType: "custom",
      sampleParagraphCount: 3,
    },
    paragraphs: [
      { id: "paragraph-1", text: "今天晚饭吃的是红烧肉，妈妈说她腰有点酸，然后我就说今天我来洗碗吧。" },
      { id: "paragraph-2", text: "我先把洗洁精挤了一大坨，然后水龙头一开全是泡泡，盘子滑溜溜的差点掉地上。然后我赶紧拿抹布把边上擦干净，再用清水冲了两遍，手指头都搓出响声了。" },
      { id: "paragraph-3", text: "洗完以后妈妈夸我洗得亮晶晶的，虽然围裙湿了一块，但是我心里美滋滋的。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["晚饭吃红烧肉", "妈妈腰酸", "洗洁精挤多冒泡泡、盘子打滑", "清水冲两遍搓出响声", "围裙湿了一块"],
      knownPitfalls: ["不得把四年级口语改写成初中生抒情腔调", "去重连续的“然后”时不能删掉盘子打滑和搓出响声的细节"],
      focusCheckpoints: ["是否保留孩子原本朴实的洗碗细节", "修改动作是否具体指向减少重复连接词与补一处抓盘子动作"],
    },
  },
  {
    id: "essay-02",
    fictional: true,
    label: "五年级·跨页叙事衔接《雨中的公交站》",
    category: "cross_page",
    pageBreakNote: "第 2 自然段在纸面第 1 页末尾写到“伞骨歪向一边，”，后半句在第 2 页首行继续。",
    config: {
      title: "雨中的温暖",
      grade: "小学五年级",
      writingRequirements: "通过雨天里的一件小事表现人与人之间的善意，注意环境与动作描写。",
      targetCharacters: 450,
      structureRequirements: "第1段：交代雨天等车的环境。\n第2段：详写陌生人共伞或帮助的经过。\n第3段：写出当时的感动。",
      scoringFocus: "环境烘托、人物动作具体、衔接自然。",
      templateType: "custom",
      sampleParagraphCount: 3,
    },
    paragraphs: [
      { id: "paragraph-1", text: "周五放学时乌云压得很低，刚走到公交站台，豆大的雨点就噼里啪啦砸了下来，风把站牌吹得直响。" },
      { id: "paragraph-2", text: "我没带伞，只好缩在广告牌角落里捂着书包。旁边一位穿黄雨衣的阿姨往我这边挪了两步，把她手里备用的折叠伞撑开递给我，伞骨歪向一边，她自己却站在风口帮我挡住斜飘过来的雨水，直到9路公交车进站。" },
      { id: "paragraph-3", text: "上车后我隔着玻璃向阿姨挥手，车窗上全是雾气，但我觉得整个车厢都是暖乎乎的。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["周五放学等9路公交车", "穿黄雨衣的阿姨递备用折叠伞并挡雨", "上车隔窗挥手"],
      knownPitfalls: ["跨页合并后的第2段长句完整，不得误判“伞骨歪向一边”后缺句", "不得把阿姨改成老爷爷或同学"],
      focusCheckpoints: ["跨页长段是否被完整理解而无残句误判", "是否指导学生把阿姨递伞和挡风的层次拆清楚"],
    },
  },
  {
    id: "essay-03",
    fictional: true,
    label: "六年级·名言跨行防误判《生活中不缺少美》",
    category: "cross_page",
    pageBreakNote: "首段引用的罗丹名言在手写纸上跨两行且漏写前引号，完整后半句紧接在同一段内。",
    config: {
      title: "生活中不缺少美",
      grade: "上海五四学制六年级",
      writingRequirements: "围绕日常生活中的普通人写一件事，写出自己发现美的过程。",
      targetCharacters: 600,
      structureRequirements: "第1段：引用名言点题并引出人物。\n第2段：写起初对人物的忽视。\n第3段：详写一次清晨目睹的细节。\n第4段：写出态度的转变与感悟。",
      scoringFocus: "首尾呼应、细节真实、过渡自然。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "罗丹曾说：生活中并不缺少美，而是缺少发现美的眼睛。以前我每天匆匆走过小区门口，从没留意过值早班的保安陈叔。" },
      { id: "paragraph-2", text: "陈叔话很少，总是穿着洗得发白的制服站在岗亭旁，我觉得他的工作枯燥又普通。" },
      { id: "paragraph-3", text: "直到上周三下霜的早晨，我提前半小时出门，看见陈叔正蹲在坡道边，用冻得通红的手把一块块防滑垫铺平，又拿干毛巾把儿童车扶手上的白霜擦干。" },
      { id: "paragraph-4", text: "那一刻晨光照在他的肩头，我忽然读懂了那句名言：认真守护别人的日常，就是身边最动人的美。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["引用罗丹名言", "小区保安陈叔", "下霜早晨铺防滑垫、擦干扶手白霜"],
      knownPitfalls: ["首段名言内容完整（仅漏双引号），严禁误判为“名言被写断/句子没写完”", "只可就漏引号给标点提醒"],
      focusCheckpoints: ["是否只指出引号标点问题而未误判名言残缺", "第2至第3段抑扬过渡建议是否贴合学生原文"],
    },
  },
  {
    id: "essay-04",
    fictional: true,
    label: "六年级·明显偏题《为自己鼓掌》",
    category: "off_topic_or_partial",
    config: {
      title: "为自己鼓掌",
      grade: "上海五四学制六年级",
      writingRequirements: "写一件让自己获得成长或勇气的亲身经历，突出“自己突破困难”的过程。",
      targetCharacters: 600,
      structureRequirements: "第1段：交代背景。\n第2段：写遇到的困难。\n第3段：详写自己面对困难的行动。\n第4段：写事情结果。\n第5段：写出为自己鼓掌的感受。",
      scoringFocus: "审题准确（主角必须是自己）、事件完整、动作具体。",
      templateType: "preset_self_applause",
      sampleParagraphCount: 5,
    },
    paragraphs: [
      { id: "paragraph-1", text: "每到端午节，外婆都会在厨房里忙上一整天，包出全家人最爱吃的鲜肉粽。" },
      { id: "paragraph-2", text: "外婆先把糯米淘洗干净，再用酱油拌好猪肉，一片片碧绿的箬叶在她手里一卷就成了小漏斗。" },
      { id: "paragraph-3", text: "我坐在小板凳上看外婆绑棉线，她手指飞快，不一会儿竹匾里就堆起了一座小山。" },
      { id: "paragraph-4", text: "粽子煮熟掀开锅盖时满屋飘香，我一口气吃了两个，连声夸外婆手艺好。" },
      { id: "paragraph-5", text: "外婆真是太能干了，我要大声为外婆鼓掌。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["off_topic"],
      mustPreserveFacts: ["端午节外婆包鲜肉粽", "“我”在旁边观看并吃粽子"],
      knownPitfalls: ["全文写为外婆鼓掌而非“为自己鼓掌”，必须准确判定为偏题（off_topic，等级C），不得硬夸切题", "改写引导应保留包粽子素材，把重心转向“我亲手学包粽子克服散漏困难”而非凭空捏造演讲比赛"],
      focusCheckpoints: ["是否正确识别审题偏差（写了外婆而非自己）", "给出的救篇方向是否沿用原有包粽子场景而非推倒换题"],
    },
  },
  {
    id: "essay-05",
    fictional: true,
    label: "六年级·详略失衡半切题《为自己鼓掌》",
    category: "off_topic_or_partial",
    config: {
      title: "为自己鼓掌",
      grade: "上海五四学制六年级",
      writingRequirements: "写一件让自己获得成长或勇气的亲身经历，详写克服困难的行动。",
      targetCharacters: 600,
      structureRequirements: "第1段：交代背景。\n第2段：写遇到的困难。\n第3段：详写面对困难的行动与转折。\n第4段：写结果。\n第5段：写成长感受。",
      scoringFocus: "详略得当、重点突出。",
      templateType: "preset_self_applause",
      sampleParagraphCount: 5,
    },
    paragraphs: [
      { id: "paragraph-1", text: "去年生日那天，爸爸带我去了市中心三楼的乐器行挑口琴，店里摆着银色的、蓝色的好几排，挑了整整一小时才买回家。" },
      { id: "paragraph-2", text: "回到家我们又去吃了火锅，晚上拆开包装盒，说明书印得很漂亮，还送了一块绒布。" },
      { id: "paragraph-3", text: "后来社区元旦汇演报了名，我练《小星星》时老是吹串音，急得嗓子发干。" },
      { id: "paragraph-4", text: "我每天对着镜子练口型，演出那天终于吹完整了。" },
      { id: "paragraph-5", text: "下台的时候，我在心里悄悄为自己鼓掌。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["partial", "fits"],
      mustPreserveFacts: ["生日买口琴", "社区元旦汇演吹《小星星》串音", "对着镜子练口型最终吹完整"],
      knownPitfalls: ["必须指出前两段逛街买琴吃火锅铺垫过长、第3至4段练琴闯关过于简略", "压缩前文时不得虚构老师单独补课等原文没有的人物"],
      focusCheckpoints: ["是否精准指出“前松后紧/详略倒置”", "学生看完建议是否清楚哪一段该删减、哪一段该展开什么动作"],
    },
  },
  {
    id: "essay-06",
    fictional: true,
    label: "六年级·保留儿童真实口吻《那次我没哭》",
    category: "colloquial",
    config: {
      title: "那次我没哭",
      grade: "上海五四学制六年级",
      writingRequirements: "记叙一次原本委屈或疼痛却忍住没哭的经历，写出心理变化。",
      targetCharacters: 550,
      structureRequirements: "第1段：点出以前爱哭与这次不同。\n第2段：写突发意外与疼痛委屈。\n第3段：写忍住眼泪的原因与行动。\n第4段：写事后回想的成长体会。",
      scoringFocus: "心理真实、不拔高喊口号。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "熟悉我的人都知道我是个“小水龙头”，以前打预防针还没扎进去眼圈就红了，可上周拔乳牙那次我真的一滴眼泪也没掉。" },
      { id: "paragraph-2", text: "躺上牙科椅听见器械嗡嗡响时，我的脚趾头都在鞋子里蜷成了一团，麻药刚过那一下酸胀得鼻子直发酸。" },
      { id: "paragraph-3", text: "正想扁嘴的时候，我瞄见玻璃门外陪我来的弟弟正扒着门缝往里瞧——出门前我还拍胸脯跟他说哥哥一点都不怕。我赶紧咬住棉球，把涌到眼眶边的热意硬生生憋了回去，还朝他比了个耶。" },
      { id: "paragraph-4", text: "走出诊所摸着微微肿起的腮帮子，我觉得自己好像一下子长高了一截。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["自称“小水龙头”", "拔乳牙脚趾蜷成一团", "弟弟扒门缝瞧、咬棉球朝弟弟比耶"],
      knownPitfalls: ["原文童趣比喻（“小水龙头”“脚趾蜷成一团”）生动自然，严禁机械改写成陈词滥调", "改动幅度宜轻，避免过度雕琢破坏原味"],
      focusCheckpoints: ["是否保留了“小水龙头”“比了个耶”等鲜活童语", "对本已优秀的段落是否克制不过度大改"],
    },
  },
  {
    id: "essay-07",
    fictional: true,
    label: "七年级·欲扬先抑结构调整《我的新同桌》",
    category: "grade_span",
    config: {
      title: "我的新同桌",
      grade: "初中七年级",
      writingRequirements: "运用欲扬先抑手法写一位同学，通过具体事件展现人物特点。",
      targetCharacters: 650,
      structureRequirements: "第1段：简短点出新同桌给我的初印象（约80字）。\n第2段：略写日常相处中觉得他“斤斤计较”的小误会（约120字）。\n第3段：详写运动会或班级事务中令我改观的关键事件（约280字）。\n第4段：回扣初印象，写出新的认识（约120字）。",
      scoringFocus: "欲扬先抑比例合理、细节刻画鲜明。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "开学换座位后，林浩成了我的新同桌。他话不多，课桌抽屉永远码得像豆腐块，连借半块橡皮都要提醒我擦完放回原位，第一周我就觉得他太古板小气了。" },
      { id: "paragraph-2", text: "有一次我值日忘了关后窗，第二天一早他就一板一眼地指着窗台上的水渍提醒我，让我脸上火辣辣的，心里更不愿意搭理他。" },
      { id: "paragraph-3", text: "转折发生在周四下午的科学实验课。我们组整理器材时不小心碰翻了烧杯，水漫湿了实验记录单，大家都慌了神。林浩一声没吭，迅速从他那个整齐的抽屉里掏出吸水纸巾、透明胶带和备用方格纸，一边帮我们垫干桌面，一边凭着他刚才随手记下的读数陪我重新誊抄了一遍。" },
      { id: "paragraph-4", text: "看着他认真核对刻度的侧脸，我才明白他的“较真”不是小气，而是事事靠谱的踏实。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["新同桌林浩抽屉整齐", "忘关后窗水渍的小误会", "科学实验课碰翻烧杯、掏纸巾与备用纸重誊读数"],
      knownPitfalls: ["第1段不能把“抑”铺得过满，需引导将具体误会集中在第2段、把第3段重誊实验数据的动作写细"],
      focusCheckpoints: ["是否贴合初中七年级记叙文语感", "对欲扬先抑详略比例的建议是否清晰具体"],
    },
  },
  {
    id: "essay-08",
    fictional: true,
    label: "七年级·生活常识时间线核查《街道阅览室的灯光》",
    category: "logic_check",
    config: {
      title: "那一盏温暖的灯",
      grade: "初中七年级",
      writingRequirements: "围绕一盏灯写一段真实可感的日常经历，细节合乎情理。",
      targetCharacters: 600,
      structureRequirements: "第1段：引出那盏灯。\n第2段：写当时的处境。\n第3段：写灯下发生的事。\n第4段：点明温暖的含义。",
      scoringFocus: "生活细节真实可信、情感自然。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "巷子口的社区便民阅览室门口有一盏橘黄色的壁灯，总让我想起去年冬天的那个夜晚。" },
      { id: "paragraph-2", text: "那天晚上凌晨两点半，我刚从学校晚托班放学背着书包路过巷口，正赶上烈日当空晒得人直冒汗，便走进正在热闹办少儿读书会的社区阅览室借书。" },
      { id: "paragraph-3", text: "管理员奶奶递给我一杯热麦茶，指了指靠窗的座位让我安心看书等妈妈下班来接。" },
      { id: "paragraph-4", text: "后来每次经过那盏橘黄色的壁灯，我心里都会涌起一阵暖意。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["partial", "off_topic"],
      mustPreserveFacts: ["社区便民阅览室橘黄色壁灯", "管理员奶奶递热麦茶等妈妈来接"],
      knownPitfalls: ["第2段同时出现“冬天夜晚”“凌晨两点半学校晚托放学”“烈日当空”“凌晨办少儿读书会”多重严重常识矛盾，必须明确指出并要求按真实放学时间（如冬日傍晚五六点）修正"],
      focusCheckpoints: ["是否敏锐抓出时间与季节/场景的常识硬伤", "修改建议是否引导学生回到傍晚放学等妈妈的合理情境"],
    },
  },
  {
    id: "essay-09",
    fictional: true,
    label: "八年级·跨页散文化叙事《修车铺的灯光》",
    category: "cross_page",
    pageBreakNote: "第 2 段至第 3 段跨页，描述补胎水槽气泡的细节分在两页。",
    config: {
      title: "微光",
      grade: "初中八年级",
      writingRequirements: "捕捉平凡劳动者身上的闪光点，语言克制有画面感。",
      targetCharacters: 700,
      structureRequirements: "第1段：勾勒冬夜推车寻铺的场景。\n第2段：细致刻画老周师傅补胎的动作神态。\n第3段：写付钱时的简短对话。\n第4段：升华平凡微光的意义。",
      scoringFocus: "白描细节、语言凝练、立意深沉。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "晚自习下课后北风刮得紧，自行车后轮突然瘪了下去，金属轮圈硌在柏油路上发出沉闷的声响。拐过街角，只有老周修车铺的卷帘门还留着半截光亮。" },
      { id: "paragraph-2", text: "老周师傅正准备收摊，见我推车进来，二话没说又把挂上墙的撬胎棒取了下来。他半跪在水泥地上，布满机油纹路的大手稳稳按住内胎浸入冷水盆，一串细碎的气泡咕嘟冒出，他在水痕处画上粉笔印，砂纸打磨声在安静的夜里格外清晰。" },
      { id: "paragraph-3", text: "补好胎打足气，我扫码付钱时想多转五元辛苦费，他摆摆手笑着拦住：“学生娃赶着回家，路上慢点骑。”" },
      { id: "paragraph-4", text: "骑进夜色里回头望去，那半截昏黄的灯光像一枚温热的印章，稳稳落在寒冷的街巷深处。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["晚自习后自行车后轮瘪胎", "老周师傅冷水盆查气泡、画粉笔印、砂纸打磨", "拒收多给的五元叮嘱慢骑"],
      knownPitfalls: ["原文已具备较好初中八年级画面感，切忌大拆大改或塞入生硬排比句"],
      focusCheckpoints: ["对高质量习作是否做到点睛式微调而非破坏原有节奏", "评语是否匹配八年级审美"],
    },
  },
  {
    id: "essay-10",
    fictional: true,
    label: "八年级·空喊口号偏离亲历要求《那一刻，我长大了》",
    category: "off_topic_or_partial",
    config: {
      title: "那一刻，我长大了",
      grade: "初中八年级",
      writingRequirements: "聚焦生活中某一个具体“瞬间”，写出内心触动，避免空泛议论。",
      targetCharacters: 650,
      structureRequirements: "第1段：引出回忆中的特定场景。\n第2段：铺垫当时的矛盾或情绪。\n第3段：定格“那一刻”的画面与内心震动。\n第4段：写出此后的行动改变。",
      scoringFocus: "“那一刻”慢镜头细节、真情实感。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "成长是一首激昂的交响曲，每个人都会在岁月的长河中迎来蜕变的华章。" },
      { id: "paragraph-2", text: "从古至今，无数仁人志士在挫折中奋起，用坚韧书写青春，我们也应当肩负起时代赋予青少年的使命。" },
      { id: "paragraph-3", text: "记得有一次我考试没考好，看着窗外的大树在风雨中挺立，那一刻我突然懂得了不经历风雨怎么见彩虹，于是我长大了。" },
      { id: "paragraph-4", text: "让我们扬起理想的风帆，向着光明的未来勇敢前进吧！" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["partial", "off_topic"],
      mustPreserveFacts: ["一次考试失利后看窗外风雨中的树"],
      knownPitfalls: ["必须直指前两段与末段空喊套话口号、“那一刻”缺乏真实具体场景，但改后示范只能在“考试失利看窗外树”这一仅存线索上做平实收束，不得凭空编造生病住院或亲人离世"],
      focusCheckpoints: ["是否准确诊断出“假大空套话、缺少具体慢镜头”", "在原文事实极少时是否守住不编造重大经历的底线"],
    },
  },
  {
    id: "essay-11",
    fictional: true,
    label: "九年级·记叙与思辨融合《慢下来，看见风景》",
    category: "grade_span",
    config: {
      title: "慢下来，看见风景",
      grade: "初中九年级",
      writingRequirements: "由自身快节奏备考生活中的一次驻足体验切入，兼具细节描写与理性思辨。",
      targetCharacters: 750,
      structureRequirements: "第1段：写九年级赶路刷题的紧绷日常。\n第2段：写一次意外放慢脚步的契机。\n第3段：细腻描摹慢下来所见的景与人。\n第4段：由景及理，写出对“快与慢”的思考。",
      scoringFocus: "景物描写贴切、叙议结合自然、立意有深度。",
      templateType: "custom",
      sampleParagraphCount: 4,
    },
    paragraphs: [
      { id: "paragraph-1", text: "升入九年级后，我的时间被切成以分钟计的碎片，连放学走过河滨步道时，眼睛也只盯着手里背诵小卡片上的古文注释。" },
      { id: "paragraph-2", text: "周六傍晚下过阵雨，石板路湿滑，我不得不收起卡片放慢脚步。" },
      { id: "paragraph-3", text: "一抬头才发现，步道旁那排平时被我当作背景板的栾树已经结满了灯笼似的蒴果，晚风拂过，淡红色的果荚簌簌落在积水边，一位白发老人正牵着学步的小孙女数地上的“小灯笼”。" },
      { id: "paragraph-4", text: "我站在树下深深吸了一口带着草木清气的晚风。赶路固然重要，但偶尔慢下半拍，心才不会被焦虑填满，前行的脚步反而更稳了。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["九年级背古文小卡片走河滨步道", "阵雨路滑收起卡片", "栾树淡红果荚如小灯笼、老人牵孙女数果荚"],
      knownPitfalls: ["不得把九年级思辨降格成低幼说教，也不得把“栾树蒴果”误改成春天桃花"],
      focusCheckpoints: ["第4段“快与慢”的思辨深化是否契合九年级水平", "植物季节细节（秋日栾树蒴果）是否准确保留"],
    },
  },
  {
    id: "essay-12",
    fictional: true,
    label: "五年级·碎段合并归组《运动会接力赛》",
    category: "colloquial",
    config: {
      title: "难忘的接力赛",
      grade: "小学五年级",
      writingRequirements: "写清楚班级接力赛中最紧张的一幕，突出团队配合。",
      targetCharacters: 450,
      structureRequirements: "第1段：写赛前检录的紧张气氛。\n第2段：详写交接棒过程与冲刺场面。\n第3段：写赛后全班欢呼与体会。",
      scoringFocus: "场面感、动作连续性、段落归组清晰。",
      templateType: "custom",
      sampleParagraphCount: 3,
    },
    paragraphs: [
      { id: "paragraph-1", text: "校运会最后一项是4乘100米接力，我跑最后一棒。" },
      { id: "paragraph-2", text: "站在白线前，我的手心全是汗。" },
      { id: "paragraph-3", text: "发令枪响了！第一棒陈宇像小豹子一样冲出去，第二棒稍微落后了一点，全班同学在看台上喊破了嗓子。" },
      { id: "paragraph-4", text: "第三棒林悦咬牙追了上来，离我只有五米了，我侧过身伸直右手往后接，啪的一声木棒稳稳落进掌心，我使出全身力气冲过红线！" },
      { id: "paragraph-5", text: "虽然最后拿了第二名，但大家抱在一起又跳又笑，这根热乎乎的接力棒让我记住了团结的力量。" },
    ],
    teacherExpectations: {
      acceptableThemeFit: ["fits"],
      mustPreserveFacts: ["4×100米最后一棒", "第一棒陈宇、第三棒林悦", "最终获得第二名（绝不能擅自改成夺得第一名！）"],
      knownPitfalls: ["学生写了5个短自然段而结构要求为3段，归组时前两段应自然并入第1结构段、第3-4段并入第2结构段", "严禁把“拿了第二名”篡改成“拿了第一名/夺冠”！"],
      focusCheckpoints: ["5段归3段是否自然无漏段", "“第二名”这一核心事实是否严格保留未被篡改为夺冠"],
    },
  },
];
