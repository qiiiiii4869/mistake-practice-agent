"""Check synthetic PDFs produced by tools/check_pdf_export.mjs, then render all pages."""
from pathlib import Path
import subprocess
import fitz

ROOT=Path(__file__).resolve().parents[1]
FOLDER=ROOT/'tmp/pdf-export-check'

def main():
    expected={'demo-class.pdf':5,'demo-student-001.pdf':2,'demo-student-002.pdf':2,'demo-student-003.pdf':1}
    for name,count in expected.items():
        path=FOLDER/name
        with fitz.open(path) as document:
            assert len(document)==count,(name,len(document))
            for page in document:
                text=page.get_text()
                assert '不可分发' in text,(name,page.number)
                assert '\ufffd' not in text,(name,page.number)
                for word in page.get_text('words'):
                    assert word[0]>=0 and word[1]>=0 and word[2]<=page.rect.width+1 and word[3]<=page.rect.height+1,(name,page.number,word)
        subprocess.run(['pdftoppm','-scale-to','1400','-png',str(path),str(FOLDER/path.stem)],check=True,capture_output=True)
    with fitz.open(FOLDER/'demo-class.pdf') as document:
        assert '参考答案与解析' not in document[0].get_text()
        assert '参考答案与解析' in document[1].get_text()
        assert '#read("private.txt")' in document[0].get_text()
        assert '光合作用' in document[0].get_text()
        assert '合成课本.pdf 第 12 页' in document[0].get_text()
        assert '没有逐题判断' in document[-1].get_text()
    print('PASS: 4 synthetic PDFs / 10 pages, Chinese, separate answer pages, citations, literal code, unavailable status and page bounds; PNGs rendered for visual QA.')

if __name__=='__main__':main()
