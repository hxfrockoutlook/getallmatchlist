const fs = require('fs');
const https = require('https');
const http = require('http'); 

// 获取上海时间
function getShanghaiTime() {
  const now = new Date();
  // 上海时间 = UTC +8
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghaiTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// 统一格式化中文日期字符串
// 处理多种格式：将"1月03日15:00"、"1月03日 15:00"等转换为"01月03日15:00"
function formatChineseDateTime(dateTimeStr) {
  try {
    if (!dateTimeStr || typeof dateTimeStr !== 'string') {
      return dateTimeStr;
    }
    
    // 去除字符串两端的空白字符
    const trimmedStr = dateTimeStr.trim();
    
    // 匹配模式：数字(1-2位)月数字(1-2位)日 空格(0或多个) 数字(1-2位):数字(2位)
    const match = trimmedStr.match(/^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/);
    
    if (!match) {
      return trimmedStr; // 返回原始字符串
    }
    
    // 提取匹配的组
    let month = match[1];  // 月
    let day = match[2];    // 日
    let hour = match[3];   // 时
    let minute = match[4]; // 分
    
    // 补全前导零（确保月份和日期都是两位数）
    month = month.padStart(2, '0');
    day = day.padStart(2, '0');
    
    // 构建格式化后的字符串
    return `${month}月${day}日${hour}:${minute}`;
  } catch (error) {
    console.error(`格式化中文日期时间错误: ${dateTimeStr}`, error);
    return dateTimeStr;
  }
}

// 修改后的 fetchWithRetry：支持 HTTP 和 HTTPS
async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        let client;
        try {
          const urlObj = new URL(url);
          client = urlObj.protocol === 'https:' ? https : http;
        } catch (e) {
          reject(new Error('Invalid URL'));
          return;
        }
        
        const req = client.get(url, options, (res) => {
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          });
        });
        
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
    } catch (error) {
      console.warn(`请求失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

/**
 * 从 M3U 地址获取数据，按指定日期（MMDD）过滤
 * 返回 Map，键为去除空格后的 tvg-id，值为聚合对象，包含 times 数组
 */
async function fetchM3UAndAggregateForDate(targetMMDD) {
  const aggregateMap = new Map();
  try {
    console.log(`开始获取 M3U 数据（日期 ${targetMMDD}）...`);
    const response = await fetchWithRetry('http://nas.168957.xyz/migu_www.php?VideoDetail=https://mg.626910.xyz:16869');
    const m3uContent = response.data;
    const lines = m3uContent.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXTINF:')) continue;
      
      // 解析 EXTINF 行属性
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
      const groupTitleMatch = line.match(/group-title="([^"]*)"/);
      
      if (!tvgIdMatch || !tvgNameMatch || !groupTitleMatch) continue;
      
      const tvgId = tvgIdMatch[1];
      const tvgName = tvgNameMatch[1];
      const groupTitle = groupTitleMatch[1];
      
      // 只保留体育组，且组名末尾日期匹配
      if (!groupTitle.startsWith('体育-')) continue;
      const dateMatch = groupTitle.match(/(\d{2})-(\d{2})$/);
      if (!dateMatch) continue;
      const groupMMDD = `${dateMatch[1]}${dateMatch[2]}`;
      if (groupMMDD !== targetMMDD) continue;
      
      // 获取下一行的 URL
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length) break;
      const url = lines[j].trim();
      i = j; // 下次循环从 URL 之后开始
      
      // 提取 competitionName（第一个空格前的内容）
      const firstSpaceIdx = tvgName.indexOf(' ');
      if (firstSpaceIdx === -1) continue; // 格式异常，跳过
      const competitionName = tvgName.substring(0, firstSpaceIdx);
      
      // 提取 time（最后一个空格后的 HH:MM）
      const lastSpaceIdx = tvgName.lastIndexOf(' ');
      if (lastSpaceIdx === -1) continue;
      const possibleTime = tvgName.substring(lastSpaceIdx + 1).trim();
      if (!/^\d{2}:\d{2}$/.test(possibleTime)) continue; // 不是时间格式，跳过
      const time = possibleTime;
      
      // 提取中间部分（去掉 competitionName 和 time）
      let middlePart = tvgName.substring(firstSpaceIdx + 1, lastSpaceIdx).trim();
      
      // 从中间部分移除 tvg-id 得到 name
      // 转义 tvgId 中的正则特殊字符
      const escapedTvgId = tvgId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const name = middlePart.replace(new RegExp(escapedTvgId, 'g'), '').trim();
      
      // 用于匹配的键：去除所有空格的 tvg-id
      const normalizedTvgId = tvgId.replace(/\s+/g, '');
      
      if (!aggregateMap.has(normalizedTvgId)) {
        // 首次遇到该 tvg-id，初始化 times 数组和 nodes 数组
        aggregateMap.set(normalizedTvgId, {
          tvgId: tvgId,
          normalizedTvgId: normalizedTvgId,
          competitionName: competitionName,
          times: [time],          // 改为数组，存储所有时间
          nodes: [{ name, url }]
        });
      } else {
        // 已存在，追加时间（可能重复，但匹配时会遍历）
        const entry = aggregateMap.get(normalizedTvgId);
        entry.times.push(time);
        entry.nodes.push({ name, url });
      }
    }
    console.log(`M3U 数据聚合完成，共 ${aggregateMap.size} 个唯一 tvg-id`);
  } catch (error) {
    console.warn('获取或解析 M3U 数据失败:', error.message);
  }
  return aggregateMap;
}

async function getMatchNodes(mgdbId) {
  const seenNodes = new Set();
  const nodes = [];
  
  try {
    const response = await fetchWithRetry(`https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/basic-data/${mgdbId}/miguvideo`, {
      headers: {
        'appVersion': '2600052000',
        'User-Agent': 'Dalvik%2F2.1.0+%28Linux%3B+U%3B+Android+9%3B+TAS-AN00+Build%2FPQ3A.190705.08211809%29',
        'terminalId': 'android',
        'appCode': 'miguvideo_default_android',
        'appType': '3',
        'appId': 'miguvideo',
        'Content-Type': 'application/json'
      }
    });
    
    const jsonData = JSON.parse(response.data);
    
    if (jsonData.code === 200 && jsonData.body && jsonData.body.multiPlayList) {
      
      // 按照新的顺序处理节点数据：replayList → liveList → preList
      const processNodeList = (nodeList) => {
        if (nodeList) {
          for (const item of nodeList) {
            const nodeKey = `${item.pID}|${item.name}`;
            if (!seenNodes.has(nodeKey)) {
              seenNodes.add(nodeKey);
              nodes.push({
                pID: item.pID,
                name: item.name
              });
            }
          }
        }
      };
      
      // 保持新的处理顺序：replayList → liveList → preList
      processNodeList(jsonData.body.multiPlayList.replayList);
      processNodeList(jsonData.body.multiPlayList.liveList);
      processNodeList(jsonData.body.multiPlayList.preList);
    }
  } catch (error) {
    console.error(`获取节点数据失败 (mgdbId: ${mgdbId}):`, error.message);
  }
  
  return nodes;
}

// ==================== 分数匹配辅助函数 ====================

function timeDiffInMinutes(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  const mins1 = h1 * 60 + m1;
  const mins2 = h2 * 60 + m2;
  const diff = Math.abs(mins1 - mins2);
  return Math.min(diff, 24 * 60 - diff);
}

function extractTeams(str) {
  if (!str) return [];
  const cleaned = str.replace(/\s+/g, '');
  const match = cleaned.match(/^(.*?)(?:vs|\d+[-:]\d+)(.*)$/i);
  return match ? [match[1], match[2]] : [];
}

function teamMatchScore(teamA, teamB) {
  const a = teamA.replace(/\s+/g, '');
  const b = teamB.replace(/\s+/g, '');
  if (a === b) return 30;
  if (a.includes(b) || b.includes(a)) return 30;
  let maxLen = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j <= a.length; j++) {
      const sub = a.substring(i, j);
      if (b.includes(sub) && sub.length > maxLen) maxLen = sub.length;
    }
  }
  const minLen = Math.min(a.length, b.length);
  if (maxLen >= minLen / 2) return 20;
  return 0;
}

function getTeamPairScore(teams1, teams2) {
  if (teams1.length !== 2 || teams2.length !== 2) return 0;
  const score1 = teamMatchScore(teams1[0], teams2[0]) + teamMatchScore(teams1[1], teams2[1]);
  const score2 = teamMatchScore(teams1[0], teams2[1]) + teamMatchScore(teams1[1], teams2[0]);
  const total = Math.max(score1, score2);
  return Math.min(total, 50);
}

function overallMatchScore(strA, strB) {
  const a = (strA || '').replace(/\s+/g, '');
  const b = (strB || '').replace(/\s+/g, '');
  if (a === b) return 50;
  if (a.includes(b) || b.includes(a)) {
    const longer = a.length >= b.length ? a : b;
    const shorter = a.length >= b.length ? b : a;
    if (shorter.length >= longer.length / 2) return 30;
  }
  return 0;
}

function competitionMatchScore(compA, compB) {
  const a = (compA || '').toLowerCase();
  const b = (compB || '').toLowerCase();
  if (a === b) return 30;
  if (a.includes(b) || b.includes(a)) return 20;
  return 0;
}

function timeMatchScore(t1, t2) {
  if (t1 === t2) return 20;
  if (timeDiffInMinutes(t1, t2) <= 30) return 10;
  return 0;
}
//=====================================================

// ==================== 主处理函数 ====================
async function fetchAndProcessData() {
  try {
    console.log('开始获取赛事数据...');
    
    // 获取主JSON数据
    const jsonResponse = await fetchWithRetry('https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo');
    const jsonData = JSON.parse(jsonResponse.data);
    
    console.log('主数据获取成功，开始处理比赛数据...');
    
    const result = [];
    
    const matchList = jsonData.body.matchList;
    const dateKeys = Object.keys(matchList).sort();
    
    // 处理每个日期的比赛
    for (const dateKey of dateKeys) {
      const matches = matchList[dateKey];
      console.log(`处理日期 ${dateKey}，共 ${matches.length} 场比赛`);

      // 从 dateKey（YYYYMMDD）提取 MMDD 用于 M3U 过滤
      const mmdd = dateKey.slice(4); // 例如 "20260404" -> "0404"
      
      // 获取该日期的 M3U 聚合数据（每个日期独立，且每个条目只能匹配一次）
      let m3uAggregateMap = await fetchM3UAndAggregateForDate(mmdd);
      
      for (const match of matches) {
        // 获取节点数据
        console.log(`获取比赛 ${match.mgdbId} 的节点数据...`);
        const nodes = await getMatchNodes(match.mgdbId);

      // 在此处插入时间处理逻辑
      let timeStr;
      if (!match.keyword) { // 判断 keyword 是否为空
          // 生成默认时间：北京时间今天零点
          const now = new Date();
          const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
          const month = String(shanghaiTime.getUTCMonth() + 1).padStart(2, '0');
          const day = String(shanghaiTime.getUTCDate()).padStart(2, '0');
          timeStr = `${month}月${day}日00:00`;
      } else {
          timeStr = formatChineseDateTime(match.keyword);
      }
        
        const mergedMatch = {
          mgdbId: match.mgdbId,
          pID: match.pID,
          title: match.title,
          //keyword: formatChineseDateTime(match.keyword),  // 使用格式化函数
          keyword: timeStr,
          sportItemId: match.sportItemId,
          matchStatus: match.matchStatus,
          matchField: match.matchField || "",
          competitionName: match.competitionName,
          padImg: match.padImg || "",
          competitionLogo: match.competitionLogo || "",
          pkInfoTitle: match.pkInfoTitle,
          modifyTitle: match.modifyTitle,
          presenters: match.presenters ? match.presenters.map(p => p.name).join(" ") : "",
          //matchInfo: { time: formatChineseDateTime(match.keyword) },
          matchInfo: { time: timeStr },
          nodes: nodes
        };

        // 分数匹配 M3U 数据并合并节点======================
        const matchTeams = extractTeams(match.pkInfoTitle);
        const matchCompetitionName = (match.competitionName || '').toLowerCase();
        const matchTimeStr = timeStr.slice(-5); // HH:MM
        
        let bestMatchTotal = 0;
        let bestMatchNodes = [];
        let bestMatchNormId = null;
        
        for (const [normId, aggItem] of m3uAggregateMap.entries()) {
          const tvgTeams = extractTeams(normId);
          let teamScore;
          if (matchTeams.length === 2 && tvgTeams.length === 2) {
            teamScore = getTeamPairScore(matchTeams, tvgTeams);
          } else {
            teamScore = overallMatchScore(match.pkInfoTitle, normId);
          }
          const compScore = competitionMatchScore(match.competitionName, aggItem.competitionName);
          let bestTimeScore = 0;
          for (const t of aggItem.times) {
            const ts = timeMatchScore(matchTimeStr, t);
            if (ts > bestTimeScore) bestTimeScore = ts;
          }
          const totalScore = teamScore + compScore + bestTimeScore;
          if (totalScore > bestMatchTotal) {
            bestMatchTotal = totalScore;
            bestMatchNodes = aggItem.nodes;
            bestMatchNormId = normId;
          }
        }
        
        if (bestMatchTotal >= 50 && bestMatchNormId) {
          mergedMatch.nodes.push(...bestMatchNodes.map(node => ({ url: node.url, name: node.name })));
          console.log(`比赛 ${match.mgdbId} 匹配到 M3U 数据，总分 ${bestMatchTotal}，追加 ${bestMatchNodes.length} 个节点`);
          // 删除已匹配的 M3U 条目，防止其他比赛误匹配
          m3uAggregateMap.delete(bestMatchNormId);
        }
        // =============================================
        
        result.push(mergedMatch);
        
        // 添加延迟以避免请求过于频繁
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // 生成最终数据
    const finalData = {
      success: true,
      updateTime: getShanghaiTime(),
      data: result
    };
    
    return finalData;
    
  } catch (error) {
    console.error('处理数据时发生错误:', error);
    return {
      success: false,
      error: error.message,
      updateTime: getShanghaiTime(),
      data: []
    };
  }
}

// 主执行函数
async function main() {
  try {
    console.log('🚀 开始执行数据获取任务...');
    
    const data = await fetchAndProcessData();
    
    // 检查数据是否有效
    if (!data.success || !data.data || Object.keys(data.data).length === 0) {
      console.log('❌ 数据获取失败或数据为空，不更新文件');
      return;
    }
    
    // 先保存到临时文件
    const tempFilename = 'sports-data-temp.json';
    fs.writeFileSync(tempFilename, JSON.stringify(data, null, 2));
    
    // 验证临时文件是否有效
    try {
      const tempData = JSON.parse(fs.readFileSync(tempFilename, 'utf8'));
      if (tempData.success && tempData.data && Object.keys(tempData.data).length > 0) {
        // 临时文件有效，替换原文件
        fs.renameSync(tempFilename, 'sports-data-latest.json');
        console.log('✅ 最新数据已保存到: sports-data-latest.json');
        console.log(`📊 共处理 ${Object.keys(data.data).length} 个日期的比赛`);
      } else {
        console.log('❌ 临时文件数据无效，不更新原文件');
        fs.unlinkSync(tempFilename); // 删除临时文件
      }
    } catch (error) {
      console.log('❌ 临时文件验证失败，不更新原文件');
      if (fs.existsSync(tempFilename)) {
        fs.unlinkSync(tempFilename); // 删除临时文件
      }
    }
    
  } catch (error) {
    console.error('❌ 执行失败:', error);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

module.exports = { fetchAndProcessData, getMatchNodes };
