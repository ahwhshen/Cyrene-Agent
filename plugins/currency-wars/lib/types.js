"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CURRENCY_WARS_SETTINGS = void 0;
exports.normalizeCurrencyWarsSettings = normalizeCurrencyWarsSettings;
exports.DEFAULT_CURRENCY_WARS_SETTINGS = {
    flowMode: "combined",
    targetMode: "fullscreen",
    autoLaunch: false,
    windowTitle: "崩坏",
    targetWords: ["忍无可忍", "第一位面强化", "第二位面强化", "第三位面强化"],
    debuffEnabled: true,
    targetMatchAny: true,
    blockedWords: ["能量逃逸"],
    blockedEnabled: true,
    investmentTargets: ["彩虹时代"],
    investmentEnabled: true,
    checkInvestmentWhenBlocked: false,
    strategyTargets: ["黑塔纪元", "采购专员"],
    inGameInvestmentTargets: ["彩虹时代", "头彩", "银·金·彩", "人才下沉", "英雄登场"],
    combinedMainRule: "stop",
    combinedBlockedRule: "ignore",
    combinedOuterInvestmentRule: "ignore",
    combinedInGameInvestmentRule: "ignore",
    fuzzyScore: 85,
    blockedFuzzyScore: 85,
    buttonFuzzyScore: 78,
    investmentFuzzyScore: 88,
    maxRounds: 0,
    stopOnTargetMatch: true,
    recognitionOnly: false,
    elevatedInput: false,
    autoDetectOcr: true,
    ocrCommand: "",
    ocrArgs: [],
};
function words(value, fallback) {
    if (!Array.isArray(value))
        return [...fallback];
    return Array.from(new Set(value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)))
        .slice(0, 20);
}
function args(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20);
}
function normalizeCurrencyWarsSettings(value) {
    const strategyTargets = words(value?.strategyTargets, exports.DEFAULT_CURRENCY_WARS_SETTINGS.strategyTargets);
    const rule = (candidate, allowed, fallback) => typeof candidate === "string" && allowed.includes(candidate) ? candidate : fallback;
    return {
        flowMode: value?.flowMode === "outer" ? "outer" : "combined",
        targetMode: value?.targetMode === "window" ? "window" : "fullscreen",
        autoLaunch: value?.autoLaunch === true,
        windowTitle: typeof value?.windowTitle === "string" && value.windowTitle.trim()
            ? value.windowTitle.trim() : exports.DEFAULT_CURRENCY_WARS_SETTINGS.windowTitle,
        targetWords: words(value?.targetWords, exports.DEFAULT_CURRENCY_WARS_SETTINGS.targetWords),
        debuffEnabled: value?.debuffEnabled === undefined ? true : Boolean(value.debuffEnabled),
        targetMatchAny: value?.targetMatchAny === undefined
            ? exports.DEFAULT_CURRENCY_WARS_SETTINGS.targetMatchAny : Boolean(value.targetMatchAny),
        blockedWords: words(value?.blockedWords, exports.DEFAULT_CURRENCY_WARS_SETTINGS.blockedWords),
        blockedEnabled: value?.blockedEnabled === undefined ? true : Boolean(value.blockedEnabled),
        investmentTargets: words(value?.investmentTargets, exports.DEFAULT_CURRENCY_WARS_SETTINGS.investmentTargets),
        investmentEnabled: value?.investmentEnabled === undefined ? true : Boolean(value.investmentEnabled),
        checkInvestmentWhenBlocked: value?.checkInvestmentWhenBlocked === true,
        strategyTargets,
        inGameInvestmentTargets: words(value?.inGameInvestmentTargets, exports.DEFAULT_CURRENCY_WARS_SETTINGS.inGameInvestmentTargets),
        combinedMainRule: rule(value?.combinedMainRule, ["ignore", "require", "stop", "optional"], "stop"),
        combinedBlockedRule: rule(value?.combinedBlockedRule, ["ignore", "restart", "continue"], "ignore"),
        combinedOuterInvestmentRule: rule(value?.combinedOuterInvestmentRule, ["ignore", "require", "optional", "stop"], "ignore"),
        combinedInGameInvestmentRule: rule(value?.combinedInGameInvestmentRule, ["ignore", "require", "optional"], "ignore"),
        fuzzyScore: Math.max(60, Math.min(100, Math.round(Number(value?.fuzzyScore) || 85))),
        blockedFuzzyScore: Math.max(60, Math.min(100, Math.round(Number(value?.blockedFuzzyScore) || 85))),
        buttonFuzzyScore: Math.max(60, Math.min(100, Math.round(Number(value?.buttonFuzzyScore) || 78))),
        investmentFuzzyScore: Math.max(60, Math.min(100, Math.round(Number(value?.investmentFuzzyScore) || 88))),
        maxRounds: Math.max(0, Math.min(999, Math.round(Number(value?.maxRounds) || 0))),
        stopOnTargetMatch: value?.stopOnTargetMatch === undefined
            ? exports.DEFAULT_CURRENCY_WARS_SETTINGS.stopOnTargetMatch : Boolean(value.stopOnTargetMatch),
        recognitionOnly: value?.recognitionOnly === undefined
            ? exports.DEFAULT_CURRENCY_WARS_SETTINGS.recognitionOnly : Boolean(value.recognitionOnly),
        elevatedInput: value?.elevatedInput === true,
        autoDetectOcr: value?.autoDetectOcr === undefined
            ? exports.DEFAULT_CURRENCY_WARS_SETTINGS.autoDetectOcr : Boolean(value.autoDetectOcr),
        ocrCommand: typeof value?.ocrCommand === "string" ? value.ocrCommand.trim() : "",
        ocrArgs: args(value?.ocrArgs),
    };
}
//# sourceMappingURL=types.js.map