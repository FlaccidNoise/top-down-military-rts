# #796 close-out columns

```
== 36a-before
  fixed 8        : atk wins 5/8 holds 0  atk KIA 70 def KIA 63  def never fired 25%  post drift median 7 m  fell back 4.6 re-lays 6.0 /battle; counterattacks ordered/reached/retook 3/3/1; seen lines withdrawing 3.6 countering 3.0 closing(atk) 51.4; grenades 6.9
  held-out 3-5   : atk wins 4/9 holds 0  atk KIA 69 def KIA 60  def never fired 34%  post drift median 5 m  fell back 4.1 re-lays 3.6 /battle; counterattacks ordered/reached/retook 3/2/2; seen lines withdrawing 2.2 countering 3.1 closing(atk) 56.8; grenades 7.7
  held-out 6-8   : atk wins 4/9 holds 0  atk KIA 74 def KIA 62  def never fired 32%  post drift median 5 m  fell back 4.0 re-lays 2.4 /battle; counterattacks ordered/reached/retook 2/0/0; seen lines withdrawing 2.3 countering 0.9 closing(atk) 44.8; grenades 3.9
  combined held-out: 8/18
  red attacking 16: atk wins 7/16 holds 2  atk KIA 64 def KIA 71  def never fired 40%  post drift median 6 m  fell back 4.8 re-lays 4.5 /battle; counterattacks ordered/reached/retook 16/8/6; seen lines withdrawing 2.0 countering 5.6 closing(atk) 59.2; grenades 7.5
  blue-attacking sets, defenders 2978: never fired 30.8% = noLos 16.8%, noEnemyEverInRange 4.8%, outBeforeAnyEnemyInRange 4.4%, broken 1.7%, crewOnGun 1.5%, task 1.1%, outsideArc 0.3%, melee 0.1%
== 36-after
  fixed 8        : atk wins 6/8 holds 0  atk KIA 67 def KIA 64  def never fired 26%  post drift median 7 m  fell back 5.0 re-lays 5.6 /battle; counterattacks ordered/reached/retook 4/4/1; seen lines withdrawing 3.5 countering 2.9 closing(atk) 53.0; grenades 10.1
  held-out 3-5   : atk wins 4/9 holds 0  atk KIA 69 def KIA 59  def never fired 34%  post drift median 5 m  fell back 4.0 re-lays 3.6 /battle; counterattacks ordered/reached/retook 3/2/2; seen lines withdrawing 2.2 countering 3.3 closing(atk) 55.4; grenades 6.7
  held-out 6-8   : atk wins 4/9 holds 0  atk KIA 74 def KIA 62  def never fired 32%  post drift median 5 m  fell back 4.0 re-lays 2.4 /battle; counterattacks ordered/reached/retook 2/0/0; seen lines withdrawing 2.3 countering 0.9 closing(atk) 44.8; grenades 3.9
  combined held-out: 8/18
  red attacking 16: atk wins 6/16 holds 2  atk KIA 65 def KIA 69  def never fired 41%  post drift median 6 m  fell back 4.6 re-lays 4.6 /battle; counterattacks ordered/reached/retook 18/10/8; seen lines withdrawing 2.1 countering 5.3 closing(atk) 57.0; grenades 8.7
  blue-attacking sets, defenders 2978: never fired 31.1% = noLos 16.8%, noEnemyEverInRange 4.9%, outBeforeAnyEnemyInRange 4.4%, broken 1.7%, crewOnGun 1.6%, task 1.2%, outsideArc 0.3%, melee 0.1%

theater path, blue attacking (u thin, v strongest garrison):
-- 33-merged
thin river-line garrison: blue wins 16/16, red 0, undecided 0; blue KIA 10 of 143; red KIA 30 of 50; garrison strength 36-51; classes {'settlement': 16}
strongest garrison (town): blue wins 15/16, red 1, undecided 0; blue KIA 40 of 143; red KIA 50 of 80; garrison strength 51-108; classes {'settlement': 14, 'hamlet': 2}
-- 34a-dug-only
thin river-line garrison: blue wins 16/16, red 0, undecided 0; blue KIA 11 of 143; red KIA 30 of 50; garrison strength 36-51; classes {'settlement': 16}
strongest garrison (town): blue wins 14/16, red 2, undecided 0; blue KIA 47 of 143; red KIA 47 of 80; garrison strength 51-108; classes {'settlement': 14, 'hamlet': 2}
-- 34-slice
thin river-line garrison: blue wins 16/16, red 0, undecided 0; blue KIA 27 of 143; red KIA 31 of 50; garrison strength 36-51; classes {'settlement': 16}
strongest garrison (town): blue wins 14/16, red 2, undecided 0; blue KIA 59 of 143; red KIA 48 of 80; garrison strength 51-108; classes {'settlement': 14, 'hamlet': 2}
-- 38-close
thin river-line garrison: blue wins 16/16, red 0, undecided 0; blue KIA 27 of 143; red KIA 31 of 50; garrison strength 36-51; classes {'settlement': 16}
strongest garrison (town): blue wins 14/16, red 2, undecided 0; blue KIA 59 of 143; red KIA 48 of 80; garrison strength 51-108; classes {'settlement': 14, 'hamlet': 2}

theater path, red attacking:
| metric | t33-merged | t38-close |
| attacker (red) wins | 4/16 | 4/16 |
| defender (blue) wins | 12/16 | 12/16 |
| holds (30 min cap) | 0/16 | 0/16 |
| attacker (red) KIA mean | 74.2 of 124 | 74.8 of 124 |
| defender (blue) KIA mean | 65.8 of 142 | 66.2 of 142 |
| per-battle result (winner red KIA/blue KIA) | bo1:b71/35 | bo2:b78/48 | bo3:b81/60 | bo4:b75/57 | op1:r68/97 | op2:b75/65 | op3:b83/89 | op4:b76/46 | ro1:r69/98 | ro2:b74/88 | ro3:r87/102 | ro4:r52/92 | wo1:b75/30 | wo2:b74/61 | wo3:b77/48 | wo4:b72/36 | bo1:b76/32 | bo2:b78/48 | bo3:b81/60 | bo4:b78/60 | op1:r69/103 | op2:b75/65 | op3:b83/89 | op4:b76/46 | ro1:r69/98 | ro2:b74/88 | ro3:r87/102 | ro4:r52/92 | wo1:b75/30 | wo2:b74/61 | wo3:b77/48 | wo4:b72/37 |
```

## what a theater-staged defender has (cmp.mjs, before the slice fielding)

| tag | strength | cls | kind | posture | untraced | map | defMen | squads | rifleSquads | mg42 | mp40 | kar98k | schreck | scoped | emplaced | shells | fausts | grenades | ammoPerMan | posts | distinctAnchors | fallback | reserve | approach | defBarr | atkBarr | atkAir | atkMen | atkHulls | objectives |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| theater town s1 | 91 | settlement | bourg | march | 0 | 320x240 | 97 | 14 | 7 | 10 | 8 | 76 | 1 | 0 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 14 | 56 | 5.9 | 14 | 13 | 8 | 1 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 8 |
| campaign 109 s1 | 109 | - | bourg | - | 0 | 320x240 | 115 | 17 | 9 | 11 | 10 | 89 | 2 | 1 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 18 | 72 | 5.9 | 17 | 16 | 8 | 3 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| campaign 91 s1 | 91 | - | bourg | - | 0 | 320x240 | 97 | 14 | 7 | 10 | 8 | 76 | 1 | 0 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 14 | 56 | 5.9 | 14 | 13 | 6 | 2 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| theater thin s1 | 44 | settlement | bourg | march | 0 | 320x240 | 50 | 7 | 3 | 5 | 4 | 40 | 0 | 0 | mg42_lafette+mortar81+pak40 | 48 | 8 | 28 | 6.2 | 7 | 6 | 4 | 0 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| theater town s9 | 102 | settlement | bourg | march | 0 | 320x240 | 108 | 15 | 8 | 11 | 9 | 85 | 1 | 0 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 18 | 68 | 5.9 | 15 | 14 | 7 | 2 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 8 |
| campaign 109 s9 | 109 | - | bourg | - | 0 | 320x240 | 115 | 17 | 9 | 11 | 10 | 89 | 2 | 1 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 18 | 72 | 5.9 | 17 | 16 | 8 | 3 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| campaign 102 s9 | 102 | - | bourg | - | 0 | 320x240 | 108 | 15 | 8 | 11 | 9 | 85 | 1 | 0 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 18 | 68 | 5.9 | 15 | 14 | 6 | 3 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| theater thin s9 | 49 | settlement | bourg | march | 0 | 320x240 | 55 | 8 | 4 | 6 | 4 | 44 | 0 | 0 | mg42_lafette+mortar81+pak40 | 48 | 8 | 32 | 6.1 | 8 | 7 | 4 | 0 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| theater town s10 | 51 | settlement | bourg | march | 0 | 320x240 | 57 | 8 | 4 | 6 | 5 | 45 | 0 | 0 | mg42_lafette+mortar81+pak40 | 48 | 8 | 32 | 6 | 8 | 7 | 4 | 0 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| campaign 109 s10 | 109 | - | bourg | - | 0 | 320x240 | 115 | 17 | 9 | 11 | 10 | 89 | 2 | 1 | mg42_lafette+mg42_lafette+mortar81+mortar81+pak40 | 96 | 18 | 72 | 5.9 | 17 | 16 | 8 | 3 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| campaign 51 s10 | 51 | - | bourg | - | 0 | 320x240 | 57 | 8 | 4 | 6 | 5 | 45 | 0 | 0 | mg42_lafette+mortar81+pak40 | 48 | 8 | 32 | 6 | 8 | 7 | 5 | 0 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |
| theater thin s10 | 51 | settlement | bourg | march | 0 | 320x240 | 57 | 8 | 4 | 6 | 5 | 45 | 0 | 0 | mg42_lafette+mortar81+pak40 | 48 | 8 | 32 | 6 | 8 | 7 | 4 | 0 | true | 1 | 2 | 1 | 143 | sherman+m3_halftrack | 7 |

## coarsefit after #796

```

blue attacking: fought (AI both sides, through makeTheaterBattle) against coarse (the constants in src now)
class            ratio   n  fought win  coarse win   fought: winner lost, loser lost   coarse: winner, loser   best-fit mult for the odds formula in src (mult in src)
settlement          1   6    0% (0/6)    12%          35%   76%                       4%   65%        1.30 (7.00)
settlement        1.5   6   33% (2/6)    17%          47%   76%                       4%   65%        
settlement          2   6  100% (6/6)    22%          41%   76%                       3%   65%        
settlement          3   6  100% (6/6)    30%          42%   77%                       3%   64%        
hamlet              1   6   50% (3/6)    25%          67%   76%                       4%   65%        0.30 (3.00)
hamlet            1.5   6  100% (6/6)    33%          58%   76%                       4%   65%        
hamlet              2   6  100% (6/6)    40%          23%   76%                       3%   64%        
hamlet              3   6  100% (6/6)    51%          22%   77%                       3%   64%        
forest              1   6   17% (1/6)    40%          44%   75%                       4%   65%        1.50 (1.50)
forest            1.5   6   33% (2/6)    51%          47%   76%                       4%   65%        
forest              2   6   83% (5/6)    58%          51%   75%                       3%   64%        
forest              3   6   83% (5/6)    67%          40%   70%                       3%   64%        
farmland            1   6    0% (0/6)    51%          48%   76%                       4%   65%        1.10 (1.00)
farmland          1.5   6   50% (3/6)    61%          53%   76%                       4%   65%        
farmland            2   6  100% (6/6)    67%          38%   76%                       4%   64%        
farmland            3   6  100% (6/6)    76%          21%   77%                       3%   64%        
marsh               1   6   67% (4/6)    51%          56%   76%                       4%   65%        0.40 (1.00)
marsh             1.5   6   67% (4/6)    61%          48%   76%                       4%   65%        
marsh               2   6  100% (6/6)    67%          34%   76%                       4%   64%        
marsh               3   6  100% (6/6)    76%          20%   77%                       3%   64%        
roadside            1   6   50% (3/6)    51%          48%   76%                       4%   65%        0.30 (1.00)
roadside          1.5   6  100% (6/6)    61%          41%   76%                       4%   65%        
roadside            2   6  100% (6/6)    67%          22%   77%                       4%   64%        
roadside            3   6  100% (6/6)    76%          15%   77%                       3%   64%        
bridge-assault      1   6    0% (0/6)    33%          36%   76%                       4%   65%        0.70 (2.00)
bridge-assault    1.5   6  100% (6/6)    43%          54%   76%                       4%   65%        
bridge-assault      2   6  100% (6/6)    51%          34%   76%                       3%   64%        
bridge-assault      3   6  100% (6/6)    61%          21%   77%                       3%   64%        
ford-assault        1   6   17% (1/6)    33%          41%   75%                       4%   65%        2.05 (2.00)
ford-assault      1.5   6   17% (1/6)    43%          36%   75%                       4%   65%        
ford-assault        2   6   67% (4/6)    51%          55%   73%                       3%   64%        
ford-assault        3   6   83% (5/6)    61%          27%   76%                       3%   64%        
losses over all 192 battles: winner p10/median/p90  21%/ 38%/ 65% · loser  75%/ 76%/ 77%

[exited with code 0]
```
