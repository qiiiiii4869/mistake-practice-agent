import type { ClassOverview,EvidenceSummary, FrozenInput, KnowledgeFact,QuestionPerformance } from './types.ts';

export function classOverview(input:FrozenInput):ClassOverview{
  const roster=input.workspace.students,scored=roster.filter(s=>s.availability==='scored');
  const totals=scored.flatMap(student=>{
    const counted=student.questions.filter(q=>q.fullScore>0),fullScore=counted.reduce((n,q)=>n+q.fullScore,0);
    if(!fullScore)return [];const score=counted.reduce((n,q)=>n+q.score,0);
    return [{student,score,fullScore,rate:score/fullScore}];
  });
  const values=totals.map(s=>s.score).sort((a,b)=>a-b),mean=values.length?values.reduce((n,v)=>n+v,0)/values.length:null;
  const definitions=[{bandId:'below_60',minRate:0,maxRate:0.6,includeMax:false},{bandId:'60_to_75',minRate:0.6,maxRate:0.75,includeMax:false},
    {bandId:'75_to_85',minRate:0.75,maxRate:0.85,includeMax:false},{bandId:'85_to_100',minRate:0.85,maxRate:1,includeMax:true}];
  const numbers=[...new Set(totals.flatMap(s=>s.student.questions.filter(q=>q.fullScore>0).map(q=>q.number)))];
  return {rosterCount:roster.length,scoredCount:totals.length,notScannedCount:roster.filter(s=>s.availability==='not_scanned').length,
    noOriginalPaperCount:roster.filter(s=>s.availability==='no_original_paper').length,notScorableCount:scored.length-totals.length,
    fullScore:totals[0]?.fullScore??0,meanScore:mean,medianScore:values.length?(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2:null,
    minScore:values[0]??null,maxScore:values.at(-1)??null,standardDeviation:mean===null?null:Math.sqrt(values.reduce((n,v)=>n+(v-mean)**2,0)/values.length),
    scoreBands:definitions.map(b=>{const group=totals.filter(s=>s.rate>=b.minRate&&(b.includeMax?s.rate<=b.maxRate:s.rate<b.maxRate));
      return {...b,studentCount:group.length,meanScoreRate:group.length?group.reduce((n,s)=>n+s.rate,0)/group.length:null,
        questionStats:numbers.map(questionNumber=>{const rows=group.flatMap(s=>s.student.questions.filter(q=>q.number===questionNumber&&q.fullScore>0));
          const correctCount=rows.filter(q=>q.score===q.fullScore).length;return {questionNumber,correctCount,participantCount:rows.length,correctRate:rows.length?correctCount/rows.length:null};})};})};
}

export function teachingEvidence(input: FrozenInput, facts: KnowledgeFact[]): EvidenceSummary {
  const scored = input.workspace.students.filter(s => s.availability === 'scored');
  const questions = scored[0]?.questions.filter(q => q.fullScore > 0) ?? [];
  const mapped = new Set(facts.flatMap(f => f.sourceNumbers).filter(n => questions.some(q => q.number === n)));
  // Compute every original question from the whole scored class, including
  // students whose personal-practice settings exclude partial-credit losses.
  const questionStats:QuestionPerformance[]=questions.map(original=>{
    let participantCount=0,correctCount=0,partialCount=0,incorrectCount=0,earnedScore=0,possibleScore=0;
    for(const student of scored){
      const q=student.questions.find(q=>q.number===original.number&&q.fullScore>0);if(!q)continue;
      participantCount++;earnedScore+=q.score;possibleScore+=q.fullScore;
      if(q.score===q.fullScore)correctCount++;else if(q.score>0)partialCount++;else incorrectCount++;
    }
    return {questionNumber:original.number,participantCount,correctCount,partialCount,incorrectCount,
      correctRate:participantCount?correctCount/participantCount:null,earnedScore,possibleScore,scoreRate:possibleScore?earnedScore/possibleScore:null,
      knowledgePointIds:[...new Set(facts.filter(f=>f.sourceNumbers.includes(original.number)).map(f=>f.factId))]};
  });
  const rows = facts.map(fact => {
    const numbers = [...new Set(fact.sourceNumbers)].filter(n => questions.some(q => q.number === n));
    const participants = new Set<string>(), losses = new Set<string>();
    let earnedScore = 0, possibleScore = 0;
    for (const student of scored) for (const q of student.questions) {
      if (!numbers.includes(q.number) || q.fullScore <= 0) continue;
      participants.add(student.id); earnedScore += q.score; possibleScore += q.fullScore;
      if (q.score < q.fullScore) losses.add(student.id);
    }
    const limitations = ['知识点映射为机器推断；正确率来自全班有效作答，部分得分不算全对；整题表现不能确定个人具体错因。'];
    if (numbers.length < 2 || participants.size < 5) limitations.push('证据有限：题目或参与人数较少。');
    return { evidenceId: `evidence-${fact.factId}`, knowledgePointId: fact.factId, knowledgePoint: fact.knowledgePoint,
      questionNumbers: numbers, earnedScore, possibleScore, participantCount: participants.size, lossCount: losses.size,
      questionStats:questionStats.filter(q=>numbers.includes(q.questionNumber)),
      scoreRate: possibleScore ? earnedScore / possibleScore : null, lossRate: participants.size ? losses.size / participants.size : null, limitations };
  });
  return { rows, questions:questionStats,classOverview:classOverview(input),mappedQuestions: mapped.size, totalQuestions: questions.length,
    mappedFullScore: questions.filter(q => mapped.has(q.number)).reduce((n,q) => n + q.fullScore,0),
    totalFullScore: questions.reduce((n,q) => n + q.fullScore,0), unmappedNumbers: questions.filter(q => !mapped.has(q.number)).map(q => q.number) };
}
