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
 * 从 M3U 地址获取数据，聚合体育相关条目（昨天、今天、明天）
 * 返回 Map，键为去除空格后的 tvg-id，值为聚合对象，包含 times 数组
 */
async function fetchM3UAndAggregate() {
  const aggregateMap = new Map();
  try {
    console.log('开始获取 M3U 数据...');
    const response = await fetchWithRetry('http://ikuai.168957.xyz:9080/migu_www.php?VideoDetail=http://1.199.194.152:5555/');
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
      
      // 只保留体育-昨天、今天、明天
      if (!groupTitle.startsWith('体育-')) continue;
      const suffix = groupTitle.substring(3);
      if (!['昨天', '今天', '明天'].includes(suffix)) continue;
      
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

/**
 * 标准化队伍字符串：忽略顺序，支持 VS 分隔（不区分大小写）
 * 例如 "热火VS76人" 和 "76人VS热火" 均返回 "76人热火"
 */
function normalizeTeamString(str) {
  if (!str) return '';
  const trimmed = str.replace(/\s+/g, ''); // 先去除所有空格
  // 匹配 VS（不区分大小写），捕获 VS 前后的内容
  const vsMatch = trimmed.match(/^(.*?)(vs)(.*)$/i);
  if (vsMatch) {
    const team1 = vsMatch[1];
    const team2 = vsMatch[3];
    // 对两个队伍名称排序，然后拼接
    const parts = [team1, team2].sort();
    return parts.join('').toLowerCase();
  }
  return trimmed.toLowerCase();
}

async function fetchAndProcessData() {
  try {
    console.log('开始获取赛事数据...');
    
    // 获取并聚合 M3U 体育数据
    const m3uAggregateMap = await fetchM3UAndAggregate();
    
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
      
      for (const match of matches) {
        // 获取节点数据
        console.log(`获取比赛 ${match.mgdbId} 的节点数据...`);
        const nodes = await getMatchNodes(match.mgdbId);
        
        const mergedMatch = {
          mgdbId: match.mgdbId,
          pID: match.pID,
          title: match.title,
          keyword: formatChineseDateTime(match.keyword),  // 使用格式化函数
          sportItemId: match.sportItemId,
          matchStatus: match.matchStatus,
          matchField: match.matchField || "",
          competitionName: match.competitionName,
          padImg: match.padImg || "",
          competitionLogo: match.competitionLogo || "",
          pkInfoTitle: match.pkInfoTitle,
          modifyTitle: match.modifyTitle,
          presenters: match.presenters ? match.presenters.map(p => p.name).join(" ") : "",
          matchInfo: { time: formatChineseDateTime(match.keyword) },
          nodes: nodes
        };

        // 匹配 M3U 数据并合并节点======================
        // 匹配 M3U 数据并合并节点（改进：tvg-id 去空格忽略大小写、时间允许多值匹配）
        const normalizedPkInfoTitle = normalizeTeamString(match.pkInfoTitle);
        const matchCompetitionName = (match.competitionName || '').toLowerCase();
        const matchTimeStr = match.keyword ? match.keyword.slice(-5) : ''; // 取最后5位 HH:MM
        
        // 将 matchTimeStr 转换为分钟数（如果格式正确）
        let matchMinutes = null;
        if (/^\d{2}:\d{2}$/.test(matchTimeStr)) {
          matchMinutes = parseInt(matchTimeStr.slice(0,2)) * 60 + parseInt(matchTimeStr.slice(3,5));
        }
        
        // 遍历聚合 Map 寻找匹配项
        for (const [normId, aggItem] of m3uAggregateMap.entries()) {
          // 比较 tvg-id（标准化处理，支持顺序无关）
          if (normalizeTeamString(normId) !== normalizedPkInfoTitle) continue;
          
          // 比较 competitionName（忽略大小写）
          if (aggItem.competitionName.toLowerCase() !== matchCompetitionName) continue;
          
          // 比较时间：检查 aggItem.times 中是否存在与 matchMinutes 相差 ≤30 分钟的时间
          if (matchMinutes === null) continue;
          let timeMatched = false;
          for (const t of aggItem.times) {
            const aggMinutes = parseInt(t.slice(0,2)) * 60 + parseInt(t.slice(3,5));
            if (Math.abs(aggMinutes - matchMinutes) <= 30) {
              timeMatched = true;
              break;
            }
          }
          if (!timeMatched) continue;
          
          // 三项匹配成功，追加节点
          mergedMatch.nodes.push(...aggItem.nodes.map(node => ({ url: node.url, name: node.name })));
          console.log(`比赛 ${match.mgdbId} 匹配到 M3U 数据，追加 ${aggItem.nodes.length} 个节点`);
          break; // 一个比赛只匹配一个 tvg-id
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
