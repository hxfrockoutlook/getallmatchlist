const fs = require('fs');
const https = require('https');

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

async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(url, options, (res) => {
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

async function getMatchNodes(mgdbId, matchStatus) {
  const seenNodes = new Set();
  const nodes = [];

  // 提取节点的通用工具函数
  const processNodeList = (list) => {
    if (list && list.length > 0) {
      for (const item of list) {
        const nodeKey = `${item.pID}|${item.name}`;
        if (!seenNodes.has(nodeKey)) {
          seenNodes.add(nodeKey);
          nodes.push({ pID: item.pID, name: item.name });
        }
      }
    }
  };

  // 解析 basic-data 响应的通用逻辑（未结束 & 降级时使用）
  const parseBasicData = (jsonData) => {
    if (jsonData.code === 200 && jsonData.body) {
      const multiPlayList = jsonData.body.multiPlayList;
      if (multiPlayList) {
        processNodeList(multiPlayList.replayList);
        processNodeList(multiPlayList.liveList);
        processNodeList(multiPlayList.preList);
      }
    }
  };

  const commonHeaders = {
    'appVersion': '2600052000',
    'User-Agent': 'Dalvik%2F2.1.0+%28Linux%3B+U%3B+Android+9%3B+TAS-AN00+Build%2FPQ3A.190705.08211809%29',
    'terminalId': 'android',
    'appCode': 'miguvideo_default_android',
    'appType': '3',
    'appId': 'miguvideo',
    'Content-Type': 'application/json'
  };

  try {
    if (matchStatus === '2') {
      // ===== 已结束比赛：优先请求 all-view-list =====
      const allViewUrl = `https://app-sc.miguvideo.com/vms-match/v5/staticcache/basic/all-view-list/${mgdbId}/2/miguvideo`;
      let needFallback = true;

      try {
        const response = await fetchWithRetry(allViewUrl, { headers: commonHeaders });
        const jsonData = JSON.parse(response.data);

        if (jsonData.code === 200 && jsonData.body) {
          const replayList = jsonData.body.replayList;
          // 仅当 replayList 存在且非空时才认为有效，否则降级
          if (replayList && replayList.length > 0) {
            processNodeList(replayList);
            needFallback = false;
          }
        }
      } catch (innerError) {
        console.warn(`all-view-list 请求失败 (mgdbId: ${mgdbId})，将降级到 basic-data:`, innerError.message);
      }

      // ===== 降级：replayList 为空/不存在 或 请求失败 → 调用 basic-data =====
      if (needFallback) {
        const basicDataUrl = `https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/basic-data/${mgdbId}/miguvideo`;
        const response = await fetchWithRetry(basicDataUrl, { headers: commonHeaders });
        const jsonData = JSON.parse(response.data);
        parseBasicData(jsonData);
      }

    } else {
      // ===== 未结束比赛：直接请求 basic-data =====
      const basicDataUrl = `https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/basic-data/${mgdbId}/miguvideo`;
      const response = await fetchWithRetry(basicDataUrl, { headers: commonHeaders });
      const jsonData = JSON.parse(response.data);
      parseBasicData(jsonData);
    }

  } catch (error) {
    console.error(`获取节点数据失败 (mgdbId: ${mgdbId}):`, error.message);
  }

  return nodes;
}

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
