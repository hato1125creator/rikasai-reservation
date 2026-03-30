document.getElementById('reservation-form').addEventListener('submit', function(event) {
    event.preventDefault(); // フォームのデフォルト送信を防ぐ
    const formData = {
        name: document.getElementById('name').value,
        contact: document.getElementById('contact').value,
        relationship: document.getElementById('relationship').value
    };


// フロントエンドのコード（form submission）
document.getElementById("reservation-form").addEventListener("submit", async function(event) {
    event.preventDefault(); // フォーム送信を一時的に中止

    const formData = new FormData(this);
    const data = Object.fromEntries(formData.entries());

    try {
        const response = await fetch('/api/send-email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });

        if (response.ok) {
            alert('予約確認のメールを送信しました。');
        } else {
            throw new Error('メール送信に失敗しました');
        }
    } catch (error) {
        console.error('エラー:', error);
        alert('エラーが発生しました。');
    }
});



    fetch('/api/reserve', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
    })
    .then(response => response.json())
    .then(data => {
        alert(data.message); // サーバーからのメッセージを表示
    })
    .catch(error => {
        console.error('エラー:', error);
    });
});
